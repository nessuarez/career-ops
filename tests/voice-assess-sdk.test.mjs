import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../voice/voice.mjs';
import { normalizeSegment, mergeSegments, assessAudioContinuous, loadSpeechSdk } from '../voice/lib/assess-sdk.mjs';
import { summarizeAssessment } from '../voice/lib/assess.mjs';

const SEGMENTS = JSON.parse(readFileSync(new URL('./fixtures/voice/assessment-sdk-segments.json', import.meta.url), 'utf8'));
const KEY = 'fake-key-0123456789abcdef';
const ENV_VARS = ['AZURE_SPEECH_KEY', 'AZURE_SPEECH_REGION'];
const ENV_OK = `AZURE_SPEECH_KEY=${KEY}\nAZURE_SPEECH_REGION=northeurope\n`;
const TH = { accuracyMin: 60, prosodyMin: 70, wpmMin: 120, wpmMax: 160, longPauseS: 1.0, maxWords: 3 };

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

// Fake Speech SDK: only the names the code uses. `end` decides how the stream finishes.
function fakeSdk({ segments = SEGMENTS, end = 'eos', errorDetails } = {}) {
  const calls = {};
  class Props {
    constructor(json) { this.json = json; }
    getProperty(id) { return id === 'JSON_RESULT' ? this.json : undefined; }
  }
  class SpeechRecognizer {
    constructor(speechConfig, audioConfig) { calls.recognizer = { speechConfig, audioConfig }; }
    startContinuousRecognitionAsync(ok) {
      calls.started = true;
      ok?.();
      setImmediate(() => {
        for (const seg of segments) this.recognized({}, { result: { reason: sdk.ResultReason.RecognizedSpeech, properties: new Props(JSON.stringify(seg)) } });
        this.recognized({}, { result: { reason: sdk.ResultReason.NoMatch, properties: new Props('{}') } });
        if (end === 'eos') this.canceled({}, { reason: sdk.CancellationReason.EndOfStream });
        else if (end === 'error') this.canceled({}, { reason: sdk.CancellationReason.Error, errorDetails });
        else this.sessionStopped({}, {});
      });
    }
    stopContinuousRecognitionAsync(ok) { calls.stopped = (calls.stopped ?? 0) + 1; ok?.(); }
    close() { calls.closed = true; }
  }
  const sdk = {
    SpeechConfig: { fromSubscription: (k, r) => { calls.sub = [k, r]; return (calls.speechConfig = {}); } },
    AudioConfig: { fromWavFileInput: (b) => { calls.wav = b; return { audio: true }; } },
    PronunciationAssessmentConfig: {
      fromJSON: (j) => {
        calls.paJson = JSON.parse(j);
        return { enableProsodyAssessment: () => { calls.prosody = true; }, applyTo: (r) => { calls.applied = r; } };
      },
    },
    PropertyId: { SpeechServiceResponse_JsonResult: 'JSON_RESULT' },
    ResultReason: { RecognizedSpeech: 3, NoMatch: 0 },
    CancellationReason: { Error: 0, EndOfStream: 1 },
    SpeechRecognizer,
  };
  return { sdk, calls };
}

// --- normalizer ---

test('normalizeSegment reads nested SDK scores and flat REST scores alike, flat winning', () => {
  const nested = normalizeSegment(SEGMENTS[0]);
  assert.equal(nested.prosody, 70);
  assert.equal(nested.words[0].AccuracyScore, 90);
  assert.equal(nested.words[0].ErrorType, 'None');
  assert.equal(nested.words[2].Phonemes[1].AccuracyScore, 40);
  assert.equal(nested.words[2].Phonemes[1].Phoneme, 'æ');
  const flat = normalizeSegment({ DisplayText: 'x', NBest: [{ ProsodyScore: 55, PronunciationAssessment: { ProsodyScore: 1 }, Words: [{ Word: 'x', Offset: 1, Duration: 2, AccuracyScore: 77, PronunciationAssessment: { AccuracyScore: 5, ErrorType: 'Mispronunciation' }, Phonemes: [{ Phoneme: 'a', AccuracyScore: 33 }] }] }] });
  assert.equal(flat.prosody, 55);
  assert.equal(flat.words[0].AccuracyScore, 77);
  assert.equal(flat.words[0].ErrorType, 'Mispronunciation');
  assert.equal(flat.words[0].Phonemes[0].AccuracyScore, 33);
});

test('normalizeSegment tolerates a segment without NBest', () => {
  assert.deepEqual(normalizeSegment({ RecognitionStatus: 'NoMatch' }).words, []);
});

// --- merge: free mode ---

test('mergeSegments (free): REST-shaped result with Microsoft-sample score formulas', () => {
  const raw = mergeSegments(SEGMENTS, {});
  assert.equal(raw.RecognitionStatus, 'Success');
  assert.equal(raw.DisplayText, 'Thanks for having me today great');
  const best = raw.NBest[0];
  assert.equal(best.Words.length, 6);
  assert.equal(best.AccuracyScore, 81.7); // mean of 90 80 50 70 100 100
  assert.equal(best.ProsodyScore, 70); // mean of segment prosody 70 60 80
  assert.equal(best.FluencyScore, 41.5); // 21.6e6 ticks of 52e6 spanned
  assert.equal(best.CompletenessScore, 100);
  assert.equal(best.PronScore, 55.3); // sorted [41.5 70 81.7] x [0.6 0.2 0.2]
});

test('mergeSegments without prosody scores falls back to the two-score formula', () => {
  const noProsody = SEGMENTS.map((s) => ({ ...s, NBest: [{ ...s.NBest[0], PronunciationAssessment: { ...s.NBest[0].PronunciationAssessment, ProsodyScore: undefined } }] }));
  const best = mergeSegments(noProsody, {}).NBest[0];
  assert.equal(best.ProsodyScore, undefined);
  assert.equal(best.PronScore, 57.6); // sorted [41.538 81.667] x [0.6 0.4]
});

test('mergeSegments: no recognized words becomes NoMatch so the summary raises its usual error', () => {
  const raw = mergeSegments([{ RecognitionStatus: 'NoMatch' }], {});
  assert.equal(raw.RecognitionStatus, 'NoMatch');
  assert.throws(() => summarizeAssessment(raw, { mode: 'free', thresholds: TH }), /NoMatch/);
  assert.equal(mergeSegments([], {}).RecognitionStatus, 'NoMatch');
});

test('merged result feeds summarizeAssessment: pause across a segment boundary, words to fix, WPM', () => {
  const s = summarizeAssessment(mergeSegments(SEGMENTS, {}), { mode: 'free', thresholds: TH });
  assert.deepEqual(s.timing.long_pauses, [{ after: 'having', s: 2.9 }]);
  assert.equal(s.timing.duration_s, 5.2);
  assert.equal(s.words_to_fix.length, 1);
  assert.equal(s.words_to_fix[0].word, 'having');
  assert.equal(s.words_to_fix[0].worst_phonemes[0].phoneme, 'æ');
  assert.equal('completeness' in s.scores, false);
  assert.ok(!JSON.stringify(s).includes('Monotone'));
});

// --- merge: scripted mode ---

test('mergeSegments (scripted): recognized word outside the reference is an Insertion', () => {
  const raw = mergeSegments(SEGMENTS, { reference: 'Thanks for having me today.' });
  const great = raw.NBest[0].Words.find((w) => w.Word === 'great');
  assert.equal(great.ErrorType, 'Insertion');
  const best = raw.NBest[0];
  assert.equal(best.AccuracyScore, 78); // insertion excluded: 390 / 5
  assert.equal(best.CompletenessScore, 100);
  assert.equal(best.PronScore, 63.1); // sorted [33.7 70 78 100] x [0.4 0.2 0.2 0.2]
  const s = summarizeAssessment(raw, { mode: 'scripted', thresholds: TH });
  assert.deepEqual(s.inserted, ['great']);
  assert.deepEqual(s.omitted, []);
});

test('mergeSegments (scripted): reference word not heard is a synthetic Omission without timing', () => {
  const raw = mergeSegments(SEGMENTS, { reference: 'Thanks, so much for having me today, great' });
  const words = raw.NBest[0].Words;
  assert.deepEqual(words.map((w) => w.Word), ['thanks', 'so', 'much', 'for', 'having', 'me', 'today', 'great']);
  for (const w of words.slice(1, 3)) {
    assert.equal(w.ErrorType, 'Omission');
    assert.equal(w.AccuracyScore, 0);
    assert.deepEqual(w.Phonemes, []);
    assert.equal(w.Offset, undefined);
  }
  const best = raw.NBest[0];
  assert.equal(best.AccuracyScore, 61.3); // 490 / 8
  assert.equal(best.CompletenessScore, 75); // 6 correct of 8
  assert.equal(best.PronScore, 57.9);
  const s = summarizeAssessment(raw, { mode: 'scripted', thresholds: TH });
  assert.deepEqual(s.omitted, ['so', 'much']);
  assert.ok(!s.words_to_fix.some((w) => w.error === 'Omission'));
  assert.equal(s.timing.duration_s, 5.2); // omissions do not break timing
  assert.deepEqual(s.timing.long_pauses.map((p) => p.after), ['having']);
});

test('mergeSegments (scripted): matching ignores case and punctuation', () => {
  const raw = mergeSegments(SEGMENTS, { reference: 'THANKS for HAVING me, today! GREAT.' });
  assert.ok(raw.NBest[0].Words.every((w) => w.ErrorType === 'None'));
});

// --- recognizer ---

test('assessAudioContinuous drives a continuous recognizer and returns the parsed segments', async () => {
  const { sdk, calls } = fakeSdk();
  const wav = makeWav(2);
  const segs = await assessAudioContinuous({ wav, reference: 'Hello there.', locale: 'en-US', region: 'northeurope', key: KEY, sdk });
  assert.equal(segs.length, 3); // NoMatch event skipped
  assert.deepEqual(calls.sub, [KEY, 'northeurope']);
  assert.equal(calls.speechConfig.speechRecognitionLanguage, 'en-US');
  assert.equal(calls.wav, wav);
  assert.equal(calls.paJson.referenceText, 'Hello there.');
  assert.equal(calls.paJson.gradingSystem, 'HundredMark');
  assert.equal(calls.paJson.granularity, 'Phoneme');
  assert.equal(calls.paJson.phonemeAlphabet, 'IPA');
  assert.equal(calls.paJson.enableMiscue, false);
  assert.equal(calls.prosody, true);
  assert.ok(calls.applied);
  assert.equal(calls.stopped, 1);
  assert.equal(calls.closed, true);
});

test('assessAudioContinuous finishes on sessionStopped too, and only once', async () => {
  const { sdk, calls } = fakeSdk({ end: 'session' });
  const segs = await assessAudioContinuous({ wav: makeWav(1), region: 'northeurope', key: KEY, sdk });
  assert.equal(segs.length, 3);
  assert.equal(calls.stopped, 1);
  assert.equal(calls.paJson.referenceText, '');
});

test('assessAudioContinuous rejects on a cancellation error and redacts the key', async () => {
  const { sdk, calls } = fakeSdk({ end: 'error', errorDetails: `Connection failed (no connection): key ${KEY} rejected` });
  await assert.rejects(
    assessAudioContinuous({ wav: makeWav(1), region: 'northeurope', key: KEY, sdk }),
    (e) => /Connection failed/.test(e.message) && !e.message.includes(KEY) && e.message.includes('[redacted]'),
  );
  assert.equal(calls.closed, true);
});

test('assessAudioContinuous refuses a region outside the allow-list before creating anything', async () => {
  const { sdk, calls } = fakeSdk();
  await assert.rejects(assessAudioContinuous({ wav: makeWav(1), region: 'evil.com/x', key: KEY, sdk }), /disallowed host/);
  assert.equal(calls.sub, undefined);
});

test('loadSpeechSdk explains how to install the SDK when the import fails', async () => {
  await assert.rejects(
    loadSpeechSdk(async () => { throw Object.assign(new Error('Cannot find package'), { code: 'ERR_MODULE_NOT_FOUND' }); }),
    /Speech SDK is needed for audio over 30 s: run `npm install` inside voice\//,
  );
  const mod = { SpeechConfig: {} };
  assert.equal(await loadSpeechSdk(async () => mod), mod);
  assert.equal(await loadSpeechSdk(async () => ({ default: mod })), mod);
});

// --- command: automatic selection and usage seconds ---

async function run(args, { audioS = 5, sdkOpts, fetchBody, files = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'voice-sdk-'));
  const saved = Object.fromEntries(ENV_VARS.map((k) => [k, process.env[k]]));
  ENV_VARS.forEach((k) => delete process.env[k]);
  try {
    writeFileSync(join(root, '.env'), ENV_OK);
    writeFileSync(join(root, 'answer.wav'), makeWav(audioS));
    for (const [n, c] of Object.entries(files)) writeFileSync(join(root, n), c);
    const fetchCalls = [];
    const fake = fakeSdk(sdkOpts);
    const out = [];
    const err = [];
    const deps = {
      root,
      now: () => Date.parse('2026-11-03T10:00:00Z'),
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
      speechSdk: fake.sdk,
      fetchImpl: async (url, init) => {
        fetchCalls.push({ url, init });
        return { ok: true, status: 200, json: async () => fetchBody };
      },
    };
    const code = await main(args.map((a) => (a.startsWith('@') ? join(root, a.slice(1)) : a)), deps);
    const dir = join(root, 'output', 'voice', 'assessments');
    const written = existsSync(dir) ? readdirSync(dir).map((n) => JSON.parse(readFileSync(join(dir, n), 'utf8'))) : [];
    const usageFile = join(root, 'data', 'voice-usage.tsv');
    const usage = existsSync(usageFile) ? readFileSync(usageFile, 'utf8') : '';
    return { code, out: out.join(''), err: err.join(''), fetchCalls, sdkCalls: fake.calls, written, usage };
  } finally {
    for (const k of ENV_VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(root, { recursive: true, force: true });
  }
}

const REST_BODY = JSON.parse(readFileSync(new URL('./fixtures/voice/assessment-free.json', import.meta.url), 'utf8'));

test('assess over 30 s goes through the SDK, writes the same summary shape and logs seconds', async () => {
  const r = await run(['assess', '--audio', '@answer.wav'], { audioS: 45 });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.fetchCalls.length, 0);
  assert.ok(r.sdkCalls.started);
  assert.equal(r.written.length, 1);
  assert.deepEqual(Object.keys(r.written[0]), ['mode', 'locale', 'transcript', 'scores', 'timing', 'words_to_fix', 'prosody_flags', 'omitted', 'inserted']);
  assert.equal(r.written[0].mode, 'free');
  assert.equal(r.err.match(/sent to Azure/g)?.length, 1);
  assert.match(r.usage, /2026-11-03\tassess\t\t45\n$/);
});

test('assess up to 30 s keeps using REST and also logs seconds', async () => {
  const r = await run(['assess', '--audio', '@answer.wav'], { audioS: 12.34, fetchBody: REST_BODY });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.fetchCalls.length, 1);
  assert.equal(r.sdkCalls.started, undefined);
  assert.match(r.usage, /2026-11-03\tassess\t\t12\.3\n$/);
});

test('assess exactly 30 s is still REST', async () => {
  const r = await run(['assess', '--audio', '@answer.wav'], { audioS: 30, fetchBody: REST_BODY });
  assert.equal(r.fetchCalls.length, 1);
});

test('assess over 30 s in scripted mode sends the reference to the SDK', async () => {
  const r = await run(['assess', '--audio', '@answer.wav', '--reference-file', '@ref.txt'], { audioS: 40, files: { 'ref.txt': 'Thanks for having me today.' } });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.sdkCalls.paJson.referenceText, 'Thanks for having me today.');
  assert.equal(r.written[0].mode, 'scripted');
  assert.deepEqual(r.written[0].inserted, ['great']);
});

test('assess over 30 s without the SDK installed gives the install hint and logs nothing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'voice-sdk-missing-'));
  const saved = Object.fromEntries(ENV_VARS.map((k) => [k, process.env[k]]));
  ENV_VARS.forEach((k) => delete process.env[k]);
  try {
    writeFileSync(join(root, '.env'), ENV_OK);
    writeFileSync(join(root, 'answer.wav'), makeWav(40));
    const err = [];
    const code = await main(['assess', '--audio', join(root, 'answer.wav')], {
      root, now: () => 0, stdout: () => {}, stderr: (s) => err.push(s),
      importSdk: async () => { throw Object.assign(new Error('nope'), { code: 'ERR_MODULE_NOT_FOUND' }); },
    });
    assert.equal(code, 1);
    assert.match(err.join(''), /npm install/);
    assert.equal(existsSync(join(root, 'data', 'voice-usage.tsv')), false);
  } finally {
    for (const k of ENV_VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(root, { recursive: true, force: true });
  }
});
