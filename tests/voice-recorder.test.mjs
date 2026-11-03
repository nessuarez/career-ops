import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../voice/voice.mjs';
import { buildSoxArgs, createSpeechDetector, record, wavInfo } from '../voice/lib/recorder.mjs';
import { loadVoiceConfig } from '../voice/lib/config.mjs';

const KEY = 'fake-key-0123456789abcdef';
const ENV_VARS = ['AZURE_SPEECH_KEY', 'AZURE_SPEECH_REGION'];
const ENV_OK = `AZURE_SPEECH_KEY=${KEY}\nAZURE_SPEECH_REGION=northeurope\n`;
const VOICES = [{ ShortName: 'en-US-JennyNeural', Locale: 'en-US', Gender: 'Female', StyleList: ['friendly'] }];

// 16-bit mono PCM WAV; `amp` is the constant sample amplitude in -1..1.
function makeWav(seconds, amp, rate = 16000) {
  const n = Math.round(seconds * rate);
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.round(amp * 32767) * (i % 2 ? -1 : 1), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVEfmt ', 8, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

// Raw 16-bit mono PCM; `amp` (0..1) is the constant sample amplitude, so the RMS equals `amp`.
function pcm(seconds, amp, rate = 16000) {
  const n = Math.round(seconds * rate);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(amp * 32767) * (i % 2 ? -1 : 1), i * 2);
  return b;
}
const cat = (...parts) => Buffer.concat(parts);
const samples = (buf) => new Int16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
const split = (buf, size) => {
  const out = [];
  for (let i = 0; i < buf.length; i += size) out.push(buf.subarray(i, i + size));
  return out;
};

const NOISE = 0.0003; // quiet room
const SPEECH = 0.02;
const QUIET_VOICE = 0.0026;

// Fake spawn: "sox" emits `audio` (a Buffer) on stdout in chunks, then exits with `code` (or errors
// with `error`). kill() stops the emission and closes with a null code, like a killed process.
function fakeSpawn({ audio = cat(pcm(0.5, NOISE), pcm(1.5, SPEECH)), chunk = 4096, code = 0, error, stderr = '' } = {}) {
  const calls = [];
  const impl = (cmd, args, opts) => {
    const call = { cmd, args, opts, killed: false };
    calls.push(call);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { call.killed = true; return true; };
    setImmediate(() => {
      if (error) return child.emit('error', Object.assign(new Error(error), { code: error }));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      for (const c of split(audio, chunk)) {
        if (call.killed) break;
        child.stdout.emit('data', c);
      }
      child.emit('close', call.killed ? null : code);
    });
    return child;
  };
  return { impl, calls };
}

const S = { record_device: 'default', record_silence_threshold: '0.15%', record_stop_silence_s: 3, record_max_s: 150 };

const tmp = () => mkdtempSync(join(tmpdir(), 'voice-rec-'));

test('buildSoxArgs streams raw PCM to stdout, caps at max, device as one argument', () => {
  assert.deepEqual(buildSoxArgs({ settings: S, max: 150, platform: 'win32' }), [
    '-q', '-t', 'waveaudio', 'default', '-r', '16000', '-c', '1', '-b', '16', '-e', 'signed-integer',
    '-t', 'raw', '-', 'trim', '0', '150',
  ]);
  const dev = buildSoxArgs({ settings: { ...S, record_device: 'USB Mic; calc' }, max: 5, platform: 'win32' });
  assert.equal(dev[3], 'USB Mic; calc');
  assert.ok(!buildSoxArgs({ settings: S, max: 2, platform: 'win32' }).includes('silence'));
});

// --- speech detector (pure) ---

const feed = (det, buf, chunk = 800) => {
  let stop = false;
  for (const c of split(buf, chunk * 2)) stop = det.push(samples(c)) || stop;
  return stop;
};
const detector = (o = {}) => createSpeechDetector({ minThreshold: 0.0015, stopSilenceS: 3, ...o });

test('detector: a stray noise followed by a long silence does not end the recording', () => {
  const det = detector();
  assert.equal(feed(det, cat(pcm(0.5, NOISE), pcm(0.4, 0.04), pcm(3.5, NOISE))), false);
  assert.equal(feed(det, pcm(2, SPEECH)), false);
  assert.equal(feed(det, pcm(2.9, NOISE)), false);
  assert.equal(feed(det, pcm(0.3, NOISE)), true);
});

test('detector: silence does not stop before one second of speech was accumulated', () => {
  const det = detector();
  assert.equal(feed(det, cat(pcm(0.5, NOISE), pcm(0.8, SPEECH), pcm(6, NOISE))), false);
  assert.ok(det.speechSeconds() < 1);
});

test('detector: stops after the silence run once speech reached one second, and reports the trim point', () => {
  const det = detector();
  feed(det, cat(pcm(0.5, NOISE), pcm(2, SPEECH)));
  assert.equal(feed(det, pcm(3.2, NOISE)), true);
  assert.ok(Math.abs(det.speechSeconds() - 2) < 0.06);
  // last speech ends at 2.5 s; at most 0.5 s of silence is kept after it
  assert.equal(det.trimSamples(), Math.round(3.0 * 16000));
});

test('detector: trim point never exceeds what was received', () => {
  const det = detector();
  feed(det, cat(pcm(0.5, NOISE), pcm(2, SPEECH), pcm(0.2, NOISE)));
  assert.equal(det.trimSamples(), Math.round(2.7 * 16000));
});

test('detector: calibration raises the threshold in a noisy room, never above 1%', () => {
  const noisy = detector();
  feed(noisy, pcm(0.6, 0.002));
  assert.ok(Math.abs(noisy.threshold() - 0.008) < 1e-4);
  const loud = detector();
  feed(loud, pcm(0.6, 0.01));
  assert.ok(Math.abs(loud.threshold() - 0.01) < 1e-9);
  const quiet = detector();
  feed(quiet, pcm(0.6, 0.0001));
  assert.ok(Math.abs(quiet.threshold() - 0.0015) < 1e-9);
});

test('detector: a minimum threshold above 1% wins over the cap', () => {
  const det = detector({ minThreshold: 0.02 });
  feed(det, pcm(0.6, NOISE));
  assert.equal(det.threshold(), 0.02);
});

test('detector: a quiet voice (0.26% RMS) counts as speech in a quiet room', () => {
  const det = detector();
  feed(det, cat(pcm(0.5, NOISE), pcm(1.5, QUIET_VOICE)));
  assert.ok(Math.abs(det.speechSeconds() - 1.5) < 0.06);
  assert.equal(feed(det, pcm(3.2, NOISE)), true);
});

test('detector: handles chunks that are not a multiple of the 50 ms window', () => {
  const det = detector();
  assert.equal(feed(det, cat(pcm(0.5, NOISE), pcm(2, SPEECH), pcm(3.2, NOISE)), 333), true);
  assert.ok(Math.abs(det.speechSeconds() - 2) < 0.06);
});

// --- record() with a fake sox ---

test('record spawns sox without a shell, writes a valid WAV and reports the duration', async () => {
  const dir = tmp();
  try {
    const sp = fakeSpawn({ audio: cat(pcm(0.5, NOISE), pcm(2, SPEECH)) });
    const r = await record({ settings: S, out: join(dir, 'a.wav'), max: 150, spawnImpl: sp.impl, platform: 'win32' });
    assert.equal(sp.calls[0].cmd, 'sox');
    assert.ok(Array.isArray(sp.calls[0].args));
    assert.ok(!sp.calls[0].opts.shell);
    assert.equal(r.path, join(dir, 'a.wav'));
    assert.ok(Math.abs(r.durationS - 2.5) < 0.01);
    assert.ok(Math.abs(wavInfo(join(dir, 'a.wav')).durationS - 2.5) < 0.01);
    assert.ok(r.peak > 0.019 && r.peak < 0.021);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('record: a stray noise then a long silence then speech is not cut early', async () => {
  const dir = tmp();
  try {
    const audio = cat(pcm(0.5, NOISE), pcm(0.4, 0.04), pcm(3.5, NOISE), pcm(2, QUIET_VOICE), pcm(4, NOISE));
    const sp = fakeSpawn({ audio, chunk: 3001 });
    const r = await record({ settings: S, out: join(dir, 'a.wav'), max: 150, spawnImpl: sp.impl, platform: 'win32' });
    // speech ends at 6.4 s; 0.5 s of trailing silence is kept
    assert.ok(Math.abs(r.durationS - 6.9) < 0.01, String(r.durationS));
    assert.equal(sp.calls[0].killed, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('record: stopping on silence kills sox, trims the trailing silence and is not a sox failure', async () => {
  const dir = tmp();
  try {
    const sp = fakeSpawn({ audio: cat(pcm(0.5, NOISE), pcm(2, SPEECH), pcm(10, NOISE)), code: 1 });
    const r = await record({ settings: S, out: join(dir, 'a.wav'), max: 150, spawnImpl: sp.impl, platform: 'win32' });
    assert.equal(sp.calls[0].killed, true);
    assert.ok(Math.abs(r.durationS - 3.0) < 0.01);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('record: reaching max without speech is rejected as no speech and deletes the file', async () => {
  const dir = tmp();
  try {
    const out = join(dir, 'a.wav');
    const sp = fakeSpawn({ audio: cat(pcm(0.5, NOISE), pcm(0.4, 0.04), pcm(4, NOISE)) });
    await assert.rejects(
      record({ settings: S, out, max: 5, spawnImpl: sp.impl, platform: 'win32' }),
      (e) => /no speech/i.test(e.message) && /record_silence_threshold/.test(e.message) && /Microphone/.test(e.message),
    );
    assert.equal(existsSync(out), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('record: reaching max with at least one second of speech keeps the recording', async () => {
  const dir = tmp();
  try {
    const sp = fakeSpawn({ audio: cat(pcm(0.5, NOISE), pcm(1.5, SPEECH), pcm(1, NOISE)) });
    const r = await record({ settings: S, out: join(dir, 'a.wav'), max: 3, spawnImpl: sp.impl, platform: 'win32' });
    assert.ok(Math.abs(r.durationS - 2.5) < 0.01); // speech ends at 2 s, 0.5 s of silence kept
    assert.equal(sp.calls[0].killed, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('record with untilSilence false keeps the full length without detection', async () => {
  const dir = tmp();
  try {
    const sp = fakeSpawn({ audio: pcm(2, 0.0001) });
    const r = await record({ settings: S, out: join(dir, 'a.wav'), max: 2, spawnImpl: sp.impl, platform: 'win32', untilSilence: false });
    assert.ok(Math.abs(r.durationS - 2) < 0.01);
    assert.equal(sp.calls[0].killed, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('record deletes the partial file when sox fails', async () => {
  const dir = tmp();
  try {
    const out = join(dir, 'a.wav');
    const sp = fakeSpawn({ code: 2, audio: pcm(1, SPEECH) });
    const impl = (cmd, args, opts) => { writeFileSync(out, 'partial'); return sp.impl(cmd, args, opts); };
    await assert.rejects(record({ settings: S, out, max: 5, spawnImpl: impl, platform: 'win32' }), /exited with code 2/);
    assert.equal(existsSync(out), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('record keeps a pre-existing file when sox is not installed', async () => {
  const dir = tmp();
  try {
    const out = join(dir, 'a.wav');
    writeFileSync(out, 'earlier recording');
    await assert.rejects(record({ settings: S, out, max: 5, spawnImpl: fakeSpawn({ error: 'ENOENT' }).impl, platform: 'win32' }), /sox was not found/);
    assert.equal(readFileSync(out, 'utf8'), 'earlier recording');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('record explains how to install sox when it is not on PATH', async () => {
  const sp = fakeSpawn({ error: 'ENOENT' });
  await assert.rejects(
    record({ settings: S, out: 'a.wav', max: 5, spawnImpl: sp.impl, platform: 'win32' }),
    (e) => /winget install ChrisBagwell\.SoX/.test(e.message) && /restart/i.test(e.message) && e.code === 'SOX_MISSING',
  );
});

test('record mentions the microphone permission path on a sox failure', async () => {
  const sp = fakeSpawn({ code: 2, stderr: 'sox FAIL formats: no device', audio: Buffer.alloc(0) });
  await assert.rejects(
    record({ settings: S, out: 'a.wav', max: 5, spawnImpl: sp.impl, platform: 'win32' }),
    (e) => /Settings > Privacy & security > Microphone/.test(e.message) && /code 2/.test(e.message) && /no device/.test(e.message),
  );
});

test('wavInfo reads duration and peak amplitude from the samples', () => {
  const dir = mkdtempSync(join(tmpdir(), 'voice-rec-'));
  try {
    writeFileSync(join(dir, 'q.wav'), makeWav(1, 0.5));
    writeFileSync(join(dir, 's.wav'), makeWav(1, 0));
    const q = wavInfo(join(dir, 'q.wav'));
    assert.ok(Math.abs(q.durationS - 1) < 0.001);
    assert.ok(Math.abs(q.peak - 0.5) < 0.001);
    assert.equal(wavInfo(join(dir, 's.wav')).peak, 0);
    writeFileSync(join(dir, 'bad.wav'), Buffer.from('not a wav at all'));
    assert.throws(() => wavInfo(join(dir, 'bad.wav')), /not a valid WAV/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config: record settings default and are validated', () => {
  const root = mkdtempSync(join(tmpdir(), 'voice-rec-cfg-'));
  const saved = Object.fromEntries(ENV_VARS.map((k) => [k, process.env[k]]));
  ENV_VARS.forEach((k) => delete process.env[k]);
  try {
    writeFileSync(join(root, '.env'), ENV_OK);
    const s = loadVoiceConfig({ root }).settings;
    assert.deepEqual(
      [s.record_device, s.record_silence_threshold, s.record_stop_silence_s, s.record_max_s],
      ['default', '0.15%', 3, 150],
    );
    mkdirSync(join(root, 'config'));
    const bad = {
      'record_device: ""': /record_device/,
      'record_device: "-x"': /record_device/,
      'record_silence_threshold: loud': /record_silence_threshold/,
      'record_silence_threshold: "150%"': /record_silence_threshold/,
      'record_stop_silence_s: 0': /record_stop_silence_s/,
      'record_stop_silence_s: 99': /record_stop_silence_s/,
      'record_max_s: -1': /record_max_s/,
      'record_max_s: 100000': /record_max_s/,
    };
    for (const [line, re] of Object.entries(bad)) {
      writeFileSync(join(root, 'config', 'voice.yml'), `voice:\n  ${line}\n`);
      assert.throws(() => loadVoiceConfig({ root }), re, line);
    }
    writeFileSync(join(root, 'config', 'voice.yml'), 'voice:\n  record_device: "Microphone (USB)"\n  record_silence_threshold: 0.5%\n  record_stop_silence_s: 2.5\n  record_max_s: 90\n');
    assert.equal(loadVoiceConfig({ root }).settings.record_max_s, 90);
  } finally {
    for (const k of ENV_VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(root, { recursive: true, force: true });
  }
});

async function run(args, { spawn = fakeSpawn(), yml, recordImpl } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'voice-recc-'));
  const saved = Object.fromEntries(ENV_VARS.map((k) => [k, process.env[k]]));
  ENV_VARS.forEach((k) => delete process.env[k]);
  try {
    writeFileSync(join(root, '.env'), ENV_OK);
    if (yml) {
      mkdirSync(join(root, 'config'));
      writeFileSync(join(root, 'config', 'voice.yml'), yml);
    }
    const out = [];
    const err = [];
    const deps = {
      root,
      now: () => Date.parse('2026-10-31T10:00:00Z'),
      platform: 'win32',
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
      spawnImpl: spawn.impl,
      recordImpl,
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => VOICES }),
    };
    const code = await main(args, deps);
    const rec = join(root, 'output', 'voice', 'recordings');
    return { code, out: out.join(''), err: err.join(''), root, calls: spawn.calls, recFiles: existsSync(rec) ? readdirSync(rec) : [] };
  } finally {
    for (const k of ENV_VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(root, { recursive: true, force: true });
  }
}

test('record writes to output/voice/recordings by default and prints path and duration', async () => {
  const r = await run(['record']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.recFiles.length, 1);
  assert.match(r.recFiles[0], /^recording-.*\.wav$/);
  assert.match(r.out, /recordings/);
  assert.match(r.out, /2\.0 s/);
  assert.match(r.out, /^Listening: speak now/);
  assert.ok(!r.out.includes(KEY) && !r.err.includes(KEY));
  const args = r.calls[0].args;
  assert.equal(args[args.indexOf('trim') + 2], '150');
});

test('record --out inside the recordings folder, --max overrides record_max_s', async () => {
  const r = await run(['record', '--out', 'drill.wav', '--max', '20'], { yml: 'voice:\n  record_max_s: 90\n  record_device: "Mic 1"\n' });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.recFiles, ['drill.wav']);
  const args = r.calls[0].args;
  assert.equal(args[args.indexOf('trim') + 2], '20');
  assert.equal(args[3], 'Mic 1');
});

test('record rejects bad --max, bad --out and escaping paths', async () => {
  for (const [a, re] of [
    [['record', '--max', '0'], /--max/],
    [['record', '--max', 'abc'], /--max/],
    [['record', '--max', '99999'], /--max/],
    [['record', '--out', 'x.mp3'], /\.wav/],
    [['record', '--out', '..\\..\\evil.wav'], /inside/],
    [['record', '--bogus'], /unknown argument/],
  ]) {
    const r = await run(a);
    assert.equal(r.code, 1, a.join(' '));
    assert.match(r.err, re);
  }
});

test('record surfaces a missing sox and a silent capture', async () => {
  const a = await run(['record'], { spawn: fakeSpawn({ error: 'ENOENT' }) });
  assert.equal(a.code, 1);
  assert.match(a.err, /winget install ChrisBagwell\.SoX/);
  const b = await run(['record'], { spawn: fakeSpawn({ code: 2 }) });
  assert.equal(b.code, 1);
  assert.match(b.err, /Microphone/);
});

// --- doctor ---

const doctorRun = (recordImpl) => run(['doctor'], { recordImpl });

test('doctor: sox present and audible test recording are ok, file is deleted', async () => {
  let seen;
  const r = await doctorRun(async ({ out, seconds }) => {
    seen = { out, seconds };
    writeFileSync(out, makeWav(2, 0.02));
    return { path: out };
  });
  assert.equal(r.code, 0);
  assert.match(r.out, /ok.*sox/);
  assert.match(r.out, /ok.*test recording/i);
  assert.equal(seen.seconds, 2);
  assert.ok(!existsSync(seen.out));
});

test('doctor warns when sox is missing, without failing', async () => {
  const r = await doctorRun(async () => {
    throw Object.assign(new Error('sox was not found on PATH: install it with "winget install ChrisBagwell.SoX" and restart the shell'), { code: 'SOX_MISSING' });
  });
  assert.equal(r.code, 0);
  assert.match(r.out, /warn.*sox/i);
  assert.match(r.out, /winget install ChrisBagwell\.SoX/);
});

test('doctor warns on a digitally silent recording (wrong mic or denied permission)', async () => {
  let file;
  const r = await doctorRun(async ({ out }) => {
    file = out;
    writeFileSync(out, makeWav(2, 0.0005));
    return { path: out };
  });
  assert.equal(r.code, 0);
  assert.match(r.out, /warn.*silent/i);
  assert.match(r.out, /microphone/i);
  assert.ok(!existsSync(file));
});

test('doctor warns on a recording failure and keeps the other checks', async () => {
  const r = await doctorRun(async () => {
    throw new Error('sox exited with code 2');
  });
  assert.equal(r.code, 0);
  assert.match(r.out, /warn.*code 2/);
  assert.match(r.out, /ok.*AZURE_SPEECH_KEY/);
});
