import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../voice/voice.mjs';
import { buildSoxArgs, record, wavInfo } from '../voice/lib/recorder.mjs';
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

// Fake spawn: "sox" writes `wav` to the .wav argument, then exits with `code` (or errors with `error`).
function fakeSpawn({ wav = makeWav(2, 0.1), code = 0, error, stderr = '' } = {}) {
  const calls = [];
  const impl = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => {
      if (error) return child.emit('error', Object.assign(new Error(error), { code: error }));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      const out = args.find((a) => a.endsWith('.wav'));
      if (code === 0 && wav) writeFileSync(out, wav);
      child.emit('close', code);
    });
    return child;
  };
  return { impl, calls };
}

const S = { record_device: 'default', record_silence_threshold: '1%', record_stop_silence_s: 3, record_max_s: 150 };

test('buildSoxArgs stops on trailing silence and caps at max, device as one argument', () => {
  assert.deepEqual(buildSoxArgs({ settings: S, out: 'a.wav', max: 150, platform: 'win32' }), [
    '-q', '-t', 'waveaudio', 'default', '-r', '16000', '-c', '1', '-b', '16', 'a.wav',
    'silence', '1', '0.1', '1%', '1', '3', '1%', 'trim', '0', '150',
  ]);
  const dev = buildSoxArgs({ settings: { ...S, record_device: 'USB Mic; calc' }, out: 'a.wav', max: 5, platform: 'win32' });
  assert.equal(dev[3], 'USB Mic; calc');
  const fixed = buildSoxArgs({ settings: S, out: 'a.wav', max: 2, platform: 'win32', untilSilence: false });
  assert.deepEqual(fixed.slice(-3), ['trim', '0', '2']);
  assert.ok(!fixed.includes('silence'));
});

test('record spawns sox without a shell and reports the duration', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'voice-rec-'));
  try {
    const sp = fakeSpawn({ wav: makeWav(2.5, 0.1) });
    const r = await record({ settings: S, out: join(dir, 'a.wav'), max: 150, spawnImpl: sp.impl, platform: 'win32' });
    assert.equal(sp.calls[0].cmd, 'sox');
    assert.ok(Array.isArray(sp.calls[0].args));
    assert.ok(!sp.calls[0].opts.shell);
    assert.equal(r.path, join(dir, 'a.wav'));
    assert.ok(Math.abs(r.durationS - 2.5) < 0.01);
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
  const sp = fakeSpawn({ code: 2, stderr: 'sox FAIL formats: no device' });
  await assert.rejects(
    record({ settings: S, out: 'a.wav', max: 5, spawnImpl: sp.impl, platform: 'win32' }),
    (e) => /Settings > Privacy & security > Microphone/.test(e.message) && /code 2/.test(e.message),
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
      ['default', '1%', 3, 150],
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
