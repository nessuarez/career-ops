import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../voice/voice.mjs';
import { buildAssessmentHeader, summarizeAssessment, assessAudio } from '../voice/lib/assess.mjs';
import { loadVoiceConfig, isAllowedHost } from '../voice/lib/config.mjs';

const FIX = (n) => JSON.parse(readFileSync(new URL(`./fixtures/voice/assessment-${n}.json`, import.meta.url), 'utf8'));
const scripted = FIX('scripted');
const free = FIX('free');
const KEY = 'fake-key-0123456789abcdef';
const ENV_VARS = ['AZURE_SPEECH_KEY', 'AZURE_SPEECH_REGION'];
const ENV_OK = `AZURE_SPEECH_KEY=${KEY}\nAZURE_SPEECH_REGION=northeurope\n`;
const TH = { accuracyMin: 60, prosodyMin: 70, wpmMin: 120, wpmMax: 160, longPauseS: 1.0, maxWords: 3 };

// 16-bit mono PCM WAV of silence-ish samples; only the header matters to assess.
function makeWav(seconds, rate = 16000) {
  const n = Math.round(seconds * rate);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + n * 2, 4);
  h.write('WAVEfmt ', 8, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(n * 2, 40);
  return Buffer.concat([h, Buffer.alloc(n * 2, 1)]);
}

const decodeHeader = (h) => JSON.parse(Buffer.from(h, 'base64').toString());

// --- header and host ---

test('header: scripted mode sends reference text, miscue, IPA, prosody and phoneme granularity', () => {
  const h = decodeHeader(buildAssessmentHeader({ reference: 'Hello there.' }));
  assert.equal(h.ReferenceText, 'Hello there.');
  assert.equal(h.GradingSystem, 'HundredMark');
  assert.equal(h.Granularity, 'Phoneme');
  assert.equal(h.EnableMiscue, true);
  assert.equal(h.EnableProsodyAssessment, true);
  assert.equal(h.PhonemeAlphabet, 'IPA');
});

test('header: free mode has no reference text and no miscue', () => {
  const h = decodeHeader(buildAssessmentHeader({}));
  assert.equal('ReferenceText' in h, false);
  assert.equal('EnableMiscue' in h, false);
  assert.equal(h.EnableProsodyAssessment, true);
});

test('allow-list admits only the matching region stt host', () => {
  assert.equal(isAllowedHost('northeurope.stt.speech.microsoft.com', 'northeurope'), true);
  assert.equal(isAllowedHost('westeurope.stt.speech.microsoft.com', 'northeurope'), false);
  assert.equal(isAllowedHost('northeurope.stt.speech.microsoft.com.evil.com', 'northeurope'), false);
});

// --- summary ---

test('summary (scripted): flat scores, completeness, omitted and inserted words', () => {
  const s = summarizeAssessment(scripted, { mode: 'scripted', locale: 'en-US', thresholds: TH });
  assert.equal(s.mode, 'scripted');
  assert.deepEqual(s.scores, { pronunciation: 64.5, accuracy: 56, fluency: 77, prosody: 72.3, completeness: 61 });
  assert.equal(s.omitted.length, 17);
  assert.equal(s.omitted[0], 'is');
  assert.deepEqual(s.inserted, ['about', 'the']);
  assert.ok(s.transcript.startsWith('Thanks for having me today'));
});

test('summary (scripted): words_to_fix is capped, worst first, with failing IPA phoneme', () => {
  const s = summarizeAssessment(scripted, { mode: 'scripted', thresholds: TH });
  assert.ok(s.words_to_fix.length <= 3);
  assert.equal(s.words_to_fix[0].word, 'changes');
  assert.equal(s.words_to_fix[0].accuracy, 46);
  assert.equal(s.words_to_fix[0].error, 'Mispronunciation');
  assert.ok(s.words_to_fix[0].worst_phonemes.length >= 1);
  assert.equal(typeof s.words_to_fix[0].worst_phonemes[0].phoneme, 'string');
  const accs = s.words_to_fix.map((w) => w.accuracy);
  assert.deepEqual(accs, [...accs].sort((a, b) => a - b));
  // omitted and inserted words are reported apart, never as words to fix
  assert.ok(!s.words_to_fix.some((w) => w.error === 'Omission' || w.error === 'Insertion'));
});

test('summary: timing uses 100 ns ticks and counts only spoken words for WPM', () => {
  const s = summarizeAssessment(scripted, { mode: 'scripted', thresholds: TH });
  assert.ok(s.timing.duration_s > 17 && s.timing.duration_s < 19);
  const spoken = 48 - 17;
  assert.ok(Math.abs(s.timing.wpm - Math.round((spoken / s.timing.duration_s) * 60)) <= 1);
});

test('summary: long pauses come from word timing, not Break.ErrorTypes', () => {
  const s = summarizeAssessment(scripted, { mode: 'scripted', thresholds: { ...TH, longPauseS: 0.4 } });
  assert.ok(s.timing.long_pauses.length >= 1);
  for (const p of s.timing.long_pauses) {
    assert.equal(typeof p.after, 'string');
    assert.ok(p.s >= 0.4);
  }
  const none = summarizeAssessment(scripted, { mode: 'scripted', thresholds: { ...TH, longPauseS: 60 } });
  assert.deepEqual(none.timing.long_pauses, []);
});

test('summary: per-word Monotone is never listed as-is', () => {
  const s = summarizeAssessment(scripted, { mode: 'scripted', thresholds: TH });
  assert.ok(!s.prosody_flags.some((f) => f.type === 'Monotone'));
  assert.ok(!JSON.stringify(s).includes('Monotone'));
});

test('summary: prosody and pace flags follow the thresholds', () => {
  const low = summarizeAssessment(scripted, { mode: 'scripted', thresholds: { ...TH, prosodyMin: 80, wpmMin: 1, wpmMax: 2 } });
  assert.ok(low.prosody_flags.some((f) => f.type === 'low_prosody' && f.score === 72.3));
  assert.ok(low.prosody_flags.some((f) => f.type === 'pace_fast'));
  const slow = summarizeAssessment(scripted, { mode: 'scripted', thresholds: { ...TH, wpmMin: 500, wpmMax: 600 } });
  assert.ok(slow.prosody_flags.some((f) => f.type === 'pace_slow'));
  const ok = summarizeAssessment(scripted, { mode: 'scripted', thresholds: { ...TH, prosodyMin: 10, wpmMin: 1, wpmMax: 1000 } });
  assert.deepEqual(ok.prosody_flags, []);
});

test('summary (free): no completeness, no omitted or inserted, transcript from Azure', () => {
  const s = summarizeAssessment(free, { mode: 'free', thresholds: TH });
  assert.equal(s.mode, 'free');
  assert.equal('completeness' in s.scores, false);
  assert.deepEqual(s.omitted, []);
  assert.deepEqual(s.inserted, []);
  assert.equal(s.transcript, free.DisplayText);
  assert.equal(s.scores.pronunciation, free.NBest[0].PronScore);
});

test('summary rejects a response that is not a successful recognition', () => {
  assert.throws(() => summarizeAssessment({ RecognitionStatus: 'NoMatch' }, { mode: 'free', thresholds: TH }), /NoMatch/);
  assert.throws(() => summarizeAssessment({ RecognitionStatus: 'Success', NBest: [] }, { mode: 'free', thresholds: TH }), /no result/i);
});

// --- REST call ---

function fakeFetch(body, status = 200) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return { impl, calls };
}

test('assessAudio posts the wav to the regional stt host with key and assessment headers', async () => {
  const f = fakeFetch(scripted);
  const wav = makeWav(2);
  const raw = await assessAudio({ wav, reference: 'Hi.', locale: 'en-US', region: 'northeurope', key: KEY, fetchImpl: f.impl });
  assert.equal(raw, scripted);
  const { url, init } = f.calls[0];
  assert.ok(url.startsWith('https://northeurope.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1'));
  assert.ok(url.includes('language=en-US'));
  assert.ok(url.includes('format=detailed'));
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['Ocp-Apim-Subscription-Key'], KEY);
  assert.ok(init.headers['Pronunciation-Assessment']);
  assert.match(init.headers['Content-Type'], /audio\/wav.*samplerate=16000/);
  assert.equal(init.body, wav);
});

test('assessAudio: 401 gives a key/region hint and never leaks the key', async () => {
  const f = fakeFetch({}, 401);
  await assert.rejects(
    assessAudio({ wav: makeWav(1), region: 'northeurope', key: KEY, fetchImpl: f.impl }),
    (e) => /401/.test(e.message) && /AZURE_SPEECH_KEY/.test(e.message) && !e.message.includes(KEY),
  );
});

test('assessAudio: a network error is redacted', async () => {
  const impl = async () => { throw new Error(`boom ${KEY}`); };
  await assert.rejects(
    assessAudio({ wav: makeWav(1), region: 'northeurope', key: KEY, fetchImpl: impl }),
    (e) => !e.message.includes(KEY) && e.message.includes('[redacted]'),
  );
});

// --- command ---

async function run(args, { body = scripted, status = 200, audioS = 5 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'voice-assess-'));
  const saved = Object.fromEntries(ENV_VARS.map((k) => [k, process.env[k]]));
  ENV_VARS.forEach((k) => delete process.env[k]);
  try {
    writeFileSync(join(root, '.env'), ENV_OK);
    writeFileSync(join(root, 'answer.wav'), makeWav(audioS));
    writeFileSync(join(root, 'ref.txt'), 'Thanks for having me today.');
    const f = fakeFetch(body, status);
    const out = [];
    const err = [];
    const code = await main(args.map((a) => (a.startsWith('@') ? join(root, a.slice(1)) : a)), {
      root,
      now: () => Date.parse('2026-11-03T10:00:00Z'),
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
      fetchImpl: f.impl,
    });
    const dir = join(root, 'output', 'voice', 'assessments');
    const written = existsSync(dir) ? readdirSync(dir).map((n) => ({ n, json: JSON.parse(readFileSync(join(dir, n), 'utf8')) })) : [];
    return { code, out: out.join(''), err: err.join(''), calls: f.calls, written };
  } finally {
    for (const k of ENV_VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(root, { recursive: true, force: true });
  }
}

test('assess (scripted) writes a summary JSON and tells the user once the voice goes to Azure', async () => {
  const r = await run(['assess', '--audio', '@answer.wav', '--reference-file', '@ref.txt']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.written.length, 1);
  assert.match(r.written[0].n, /^2026-11-03-answer.*\.json$/);
  assert.equal(r.written[0].json.mode, 'scripted');
  assert.equal(r.calls.length, 1);
  assert.equal(decodeHeader(r.calls[0].init.headers['Pronunciation-Assessment']).ReferenceText, 'Thanks for having me today.');
  assert.equal(r.err.match(/sent to Azure/g)?.length, 1);
  assert.ok(r.out.includes(r.written[0].n));
});

test('assess (free) sends no reference text', async () => {
  const r = await run(['assess', '--audio', '@answer.wav'], { body: free });
  assert.equal(r.code, 0, r.err);
  assert.equal('ReferenceText' in decodeHeader(r.calls[0].init.headers['Pronunciation-Assessment']), false);
  assert.equal(r.written[0].json.mode, 'free');
});

test('assess refuses audio over 30 s before any network call and points to the SDK path', async () => {
  const r = await run(['assess', '--audio', '@answer.wav'], { audioS: 31 });
  assert.equal(r.code, 1);
  assert.match(r.err, /30 s/);
  assert.match(r.err, /SDK/);
  assert.equal(r.calls.length, 0);
  assert.equal(r.written.length, 0);
});

test('assess needs --audio and an existing file', async () => {
  assert.equal((await run(['assess'])).code, 1);
  const r = await run(['assess', '--audio', '@missing.wav']);
  assert.equal(r.code, 1);
  assert.match(r.err, /not found/);
  assert.equal(r.calls.length, 0);
});

test('assess thresholds are configurable in config/voice.yml and validated', () => {
  const root = mkdtempSync(join(tmpdir(), 'voice-assess-cfg-'));
  const saved = Object.fromEntries(ENV_VARS.map((k) => [k, process.env[k]]));
  ENV_VARS.forEach((k) => delete process.env[k]);
  try {
    writeFileSync(join(root, '.env'), ENV_OK);
    assert.equal(loadVoiceConfig({ root }).settings.assess_accuracy_min, 60);
    mkdirSync(join(root, 'config'));
    writeFileSync(join(root, 'config', 'voice.yml'), 'voice:\n  assess_accuracy_min: 80\n  assess_wpm_min: 100\n');
    const s = loadVoiceConfig({ root }).settings;
    assert.equal(s.assess_accuracy_min, 80);
    assert.equal(s.assess_wpm_min, 100);
    writeFileSync(join(root, 'config', 'voice.yml'), 'voice:\n  assess_wpm_min: 200\n  assess_wpm_max: 100\n');
    assert.throws(() => loadVoiceConfig({ root }), /assess_wpm/);
  } finally {
    for (const k of ENV_VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(root, { recursive: true, force: true });
  }
});
