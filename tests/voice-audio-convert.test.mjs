import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../voice/voice.mjs';
import { parseWavHeader, isSpeechReadyWav, buildFfmpegArgs, convertToWav, checkFfmpeg } from '../voice/lib/audio.mjs';

const KEY = 'fake-key-0123456789abcdef';
const ENV_VARS = ['AZURE_SPEECH_KEY', 'AZURE_SPEECH_REGION'];
const ENV_OK = `AZURE_SPEECH_KEY=${KEY}\nAZURE_SPEECH_REGION=northeurope\n`;
const FREE = JSON.parse(readFileSync(new URL('./fixtures/voice/assessment-free.json', import.meta.url), 'utf8'));

function makeWav(seconds, { rate = 16000, channels = 1, bits = 16 } = {}) {
  const bytesPerSample = (bits / 8) * channels;
  const n = Math.round(seconds * rate);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + n * bytesPerSample, 4);
  h.write('WAVEfmt ', 8, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * bytesPerSample, 28);
  h.writeUInt16LE(bytesPerSample, 32);
  h.writeUInt16LE(bits, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(n * bytesPerSample, 40);
  return Buffer.concat([h, Buffer.alloc(n * bytesPerSample, 1)]);
}

// Fake ffmpeg: writes a 16 kHz mono WAV of `outSeconds` to the last argument, like the real converter.
function fakeFfmpeg({ code = 0, error, outSeconds = 5 } = {}) {
  const calls = [];
  const impl = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => {
      if (!args.includes('-i')) return child.emit('close', error ? 1 : 0); // the -version probe
      if (error) return child.emit('error', Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: error }));
      if (code === 0) writeFileSync(args.at(-1), makeWav(outSeconds));
      else {
        writeFileSync(args.at(-1), 'partial');
        child.stderr.emit('data', 'Invalid data found when processing input');
      }
      child.emit('close', code);
    });
    return child;
  };
  return { impl, calls };
}

// --- WAV header ---

test('parseWavHeader gives format and duration from data size / byte rate', () => {
  const h = parseWavHeader(makeWav(2.5));
  assert.deepEqual({ ...h, durationS: Math.round(h.durationS * 100) / 100 }, { format: 1, channels: 1, rate: 16000, bits: 16, durationS: 2.5 });
  assert.equal(parseWavHeader(Buffer.from('not a wav at all, definitely')), null);
  assert.equal(parseWavHeader(Buffer.alloc(3)), null);
});

test('parseWavHeader clips a data size larger than the buffer', () => {
  const b = makeWav(1);
  b.writeUInt32LE(0xffffffff, 40); // streamed WAVs leave a bogus size
  assert.equal(parseWavHeader(b).durationS, 1);
});

test('isSpeechReadyWav accepts only 16 kHz mono 16-bit PCM', () => {
  assert.equal(isSpeechReadyWav(parseWavHeader(makeWav(1))), true);
  assert.equal(isSpeechReadyWav(parseWavHeader(makeWav(1, { rate: 44100 }))), false);
  assert.equal(isSpeechReadyWav(parseWavHeader(makeWav(1, { channels: 2 }))), false);
  assert.equal(isSpeechReadyWav(parseWavHeader(makeWav(1, { bits: 8 }))), false);
  assert.equal(isSpeechReadyWav(null), false);
});

// --- ffmpeg ---

test('buildFfmpegArgs converts to 16 kHz mono signed 16-bit WAV', () => {
  assert.deepEqual(buildFfmpegArgs('in.m4a', 'out.wav'), ['-y', '-hide_banner', '-loglevel', 'error', '-i', 'in.m4a', '-ac', '1', '-ar', '16000', '-sample_fmt', 's16', 'out.wav']);
});

test('convertToWav spawns ffmpeg without a shell and resolves with the output path', async () => {
  const f = fakeFfmpeg();
  const out = join(tmpdir(), `career-ops-conv-${process.pid}.wav`);
  try {
    assert.equal(await convertToWav({ input: 'a b.m4a', out, spawnImpl: f.impl }), out);
    assert.equal(f.calls[0].cmd, 'ffmpeg');
    assert.deepEqual(f.calls[0].args, buildFfmpegArgs('a b.m4a', out));
    assert.ok(!f.calls[0].opts?.shell);
  } finally {
    rmSync(out, { force: true });
  }
});

test('convertToWav: ffmpeg missing gives the install hint', async () => {
  await assert.rejects(
    convertToWav({ input: 'a.m4a', out: 'x.wav', spawnImpl: fakeFfmpeg({ error: 'ENOENT' }).impl }),
    /ffmpeg not found on PATH; install it \(winget install Gyan\.FFmpeg\) and restart the shell/,
  );
});

test('convertToWav: a failing ffmpeg reports its last message and leaves no partial file', async () => {
  const out = join(tmpdir(), `career-ops-conv-fail-${process.pid}.wav`);
  await assert.rejects(convertToWav({ input: 'a.m4a', out, spawnImpl: fakeFfmpeg({ code: 1 }).impl }), /ffmpeg failed.*Invalid data/);
  assert.equal(existsSync(out), false);
});

test('checkFfmpeg resolves ok when ffmpeg runs and not ok when it is missing', async () => {
  const ok = fakeFfmpeg();
  assert.equal((await checkFfmpeg({ spawnImpl: ok.impl })).ok, true);
  assert.deepEqual(ok.calls[0].args, ['-version']);
  const missing = await checkFfmpeg({ spawnImpl: fakeFfmpeg({ error: 'ENOENT' }).impl });
  assert.equal(missing.ok, false);
  assert.match(missing.message, /winget install Gyan\.FFmpeg/);
});

// --- command ---

async function run(args, { files = {}, ffmpeg = fakeFfmpeg(), fetchBody = FREE } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'voice-conv-'));
  const saved = Object.fromEntries(ENV_VARS.map((k) => [k, process.env[k]]));
  ENV_VARS.forEach((k) => delete process.env[k]);
  try {
    writeFileSync(join(root, '.env'), ENV_OK);
    for (const [n, c] of Object.entries(files)) writeFileSync(join(root, n), c);
    const fetchCalls = [];
    const out = [];
    const err = [];
    const code = await main(args.map((a) => (a.startsWith('@') ? join(root, a.slice(1)) : a)), {
      root,
      now: () => Date.parse('2026-11-03T10:00:00Z'),
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
      spawnImpl: ffmpeg.impl,
      fetchImpl: async (url, init) => {
        fetchCalls.push({ url, init });
        return { ok: true, status: 200, json: async () => fetchBody };
      },
    });
    const tmp = join(root, 'output', 'voice', 'tmp');
    const usageFile = join(root, 'data', 'voice-usage.tsv');
    return {
      code,
      err: err.join(''),
      fetchCalls,
      ffmpegCalls: ffmpeg.calls,
      tmpLeft: existsSync(tmp) ? readdirSync(tmp) : [],
      usage: existsSync(usageFile) ? readFileSync(usageFile, 'utf8') : '',
      root,
    };
  } finally {
    for (const k of ENV_VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(root, { recursive: true, force: true });
  }
}

test('assess converts a phone file with ffmpeg into output/voice/tmp, assesses it and deletes the temp', async () => {
  const r = await run(['assess', '--audio', '@memo.m4a'], { files: { 'memo.m4a': 'not really audio' }, ffmpeg: fakeFfmpeg({ outSeconds: 7 }) });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.ffmpegCalls.length, 1);
  const a = r.ffmpegCalls[0].args;
  assert.ok(a[a.indexOf('-i') + 1].endsWith('memo.m4a'));
  assert.ok(a.at(-1).includes(join('output', 'voice', 'tmp')));
  assert.equal(r.fetchCalls.length, 1);
  assert.deepEqual(r.tmpLeft, []);
  assert.match(r.usage, /assess\t\t7\n$/);
});

test('assess converts a WAV that is not 16 kHz mono 16-bit', async () => {
  const r = await run(['assess', '--audio', '@stereo.wav'], { files: { 'stereo.wav': makeWav(3, { rate: 44100, channels: 2 }) } });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.ffmpegCalls.length, 1);
});

test('assess does not run ffmpeg for a 16 kHz mono WAV', async () => {
  const r = await run(['assess', '--audio', '@ok.wav'], { files: { 'ok.wav': makeWav(3) } });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.ffmpegCalls.length, 0);
});

test('assess cleans the temp file when the assessment fails after conversion', async () => {
  const r = await run(['assess', '--audio', '@memo.mp3'], { files: { 'memo.mp3': 'x' }, fetchBody: { RecognitionStatus: 'NoMatch' } });
  assert.equal(r.code, 1);
  assert.equal(r.ffmpegCalls.length, 1);
  assert.deepEqual(r.tmpLeft, []);
});

test('assess with ffmpeg missing explains how to install it and calls no network', async () => {
  const r = await run(['assess', '--audio', '@memo.m4a'], { files: { 'memo.m4a': 'x' }, ffmpeg: fakeFfmpeg({ error: 'ENOENT' }) });
  assert.equal(r.code, 1);
  assert.match(r.err, /winget install Gyan\.FFmpeg/);
  assert.equal(r.fetchCalls.length, 0);
  assert.deepEqual(r.tmpLeft, []);
});
