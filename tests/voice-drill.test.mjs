import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { main } from '../voice/voice.mjs';
import { loadVoiceConfig } from '../voice/lib/config.mjs';

const scripted = JSON.parse(readFileSync(new URL('./fixtures/voice/assessment-scripted.json', import.meta.url), 'utf8'));
const KEY = 'fake-key-0123456789abcdef';
const ENV_VARS = ['AZURE_SPEECH_KEY', 'AZURE_SPEECH_REGION'];
const ENV_OK = `AZURE_SPEECH_KEY=${KEY}\nAZURE_SPEECH_REGION=northeurope\n`;
const NOW = Date.parse('2026-11-03T10:00:00Z');

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
const REF_MD = '# Intro\n\nThanks for **having** me today. See [my site](https://x.test).\n\n<!-- note -->\n';

async function run(args, { yml, assessStatus = 200, recordFails = false, ref = REF_MD } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'voice-drill-'));
  const saved = Object.fromEntries(ENV_VARS.map((k) => [k, process.env[k]]));
  ENV_VARS.forEach((k) => delete process.env[k]);
  try {
    writeFileSync(join(root, '.env'), ENV_OK);
    if (yml) {
      mkdirSync(join(root, 'config'));
      writeFileSync(join(root, 'config', 'voice.yml'), yml);
    }
    writeFileSync(join(root, 'ref.md'), ref);
    const events = [];
    const assessCalls = [];
    const out = [];
    const err = [];
    const deps = {
      root,
      now: () => NOW,
      platform: 'darwin',
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
      sleep: async () => {},
      recordImpl: async ({ out: file }) => {
        events.push('record');
        if (recordFails) throw new Error('no microphone');
        mkdirSync(join(file, '..'), { recursive: true });
        writeFileSync(file, makeWav(5));
        return { path: file, durationS: 5 };
      },
      fetchImpl: async (url, init) => {
        if (String(url).includes('voices/list')) return { ok: true, status: 200, json: async () => [{ ShortName: 'en-US-JennyNeural', StyleList: ['friendly'] }] };
        if (String(url).includes('.stt.')) {
          events.push('assess');
          assessCalls.push({ url, init });
          return { ok: assessStatus === 200, status: assessStatus, json: async () => scripted };
        }
        return { ok: true, status: 200, arrayBuffer: async () => makeWav(1, 24000) };
      },
      spawnImpl: () => {
        events.push('play');
        const ee = new EventEmitter();
        setImmediate(() => ee.emit('close', 0));
        return ee;
      },
    };
    const code = await main(args.map((a) => (a.startsWith('@') ? join(root, a.slice(1)) : a)), deps);
    const rec = join(root, 'output', 'voice', 'recordings');
    const asm = join(root, 'output', 'voice', 'assessments');
    return {
      code,
      events,
      assessCalls,
      out: out.join(''),
      err: err.join(''),
      recordings: existsSync(rec) ? readdirSync(rec) : [],
      assessments: existsSync(asm) ? readdirSync(asm) : [],
    };
  } finally {
    for (const k of ENV_VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(root, { recursive: true, force: true });
  }
}

test('drill sends the cleaned reference text as ReferenceText and writes the summary', async () => {
  const r = await run(['drill', '--reference-file', '@ref.md']);
  assert.equal(r.code, 0, r.err);
  const h = decodeHeader(r.assessCalls[0].init.headers['Pronunciation-Assessment']);
  assert.ok(h.ReferenceText.includes('Thanks for having me today.'));
  assert.ok(!/[*#<\[]|https?:/.test(h.ReferenceText), h.ReferenceText);
  assert.equal(r.assessments.length, 1);
  assert.match(r.out, /\.json/);
  assert.match(r.out, /pronunciation/i);
  assert.match(r.out, /wpm/i);
  assert.match(r.out, /changes/);
  assert.equal(r.err.match(/sent to Azure/g)?.length, 1);
});

test('drill --listen-first plays the text before recording, then assesses', async () => {
  const r = await run(['drill', '--reference-file', '@ref.md', '--listen-first']);
  assert.equal(r.code, 0, r.err);
  assert.ok(r.events.includes('play'));
  assert.ok(r.events.indexOf('play') < r.events.indexOf('record'));
  assert.ok(r.events.indexOf('record') < r.events.indexOf('assess'));
});

test('drill without --listen-first does not play anything', async () => {
  const r = await run(['drill', '--reference-file', '@ref.md']);
  assert.deepEqual(r.events, ['record', 'assess']);
});

test('drill deletes its recording by default (keep_recordings false)', async () => {
  const r = await run(['drill', '--reference-file', '@ref.md']);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.recordings, []);
  assert.equal(r.assessments.length, 1);
});

test('drill keeps its recording when keep_recordings is true', async () => {
  const r = await run(['drill', '--reference-file', '@ref.md'], { yml: 'voice:\n  keep_recordings: true\n' });
  assert.equal(r.recordings.length, 1);
  assert.match(r.recordings[0], /\.wav$/);
});

test('drill deletes the recording even when the assessment fails', async () => {
  const r = await run(['drill', '--reference-file', '@ref.md'], { assessStatus: 500 });
  assert.equal(r.code, 1);
  assert.deepEqual(r.recordings, []);
  assert.deepEqual(r.assessments, []);
});

test('drill: a failed recording stops before assessing', async () => {
  const r = await run(['drill', '--reference-file', '@ref.md'], { recordFails: true });
  assert.equal(r.code, 1);
  assert.match(r.err, /no microphone/);
  assert.ok(!r.events.includes('assess'));
});

test('drill rejects a missing, empty or markup-only reference before recording', async () => {
  for (const [args, ref, re] of [
    [['drill'], REF_MD, /--reference-file/],
    [['drill', '--reference-file', '@nope.md'], REF_MD, /not found/],
    [['drill', '--reference-file', '@ref.md'], '   \n', /empty|nothing/i],
    [['drill', '--reference-file', '@ref.md'], '<!-- only a comment -->\n', /empty|nothing/i],
  ]) {
    const r = await run(args, { ref });
    assert.equal(r.code, 1);
    assert.match(r.err, re);
    assert.deepEqual(r.events, []);
  }
});

test('keep_recordings is a validated boolean, default false', () => {
  const root = mkdtempSync(join(tmpdir(), 'voice-drill-cfg-'));
  const saved = Object.fromEntries(ENV_VARS.map((k) => [k, process.env[k]]));
  ENV_VARS.forEach((k) => delete process.env[k]);
  try {
    writeFileSync(join(root, '.env'), ENV_OK);
    assert.equal(loadVoiceConfig({ root }).settings.keep_recordings, false);
    mkdirSync(join(root, 'config'));
    writeFileSync(join(root, 'config', 'voice.yml'), 'voice:\n  keep_recordings: "yes"\n');
    assert.throws(() => loadVoiceConfig({ root }), /keep_recordings/);
  } finally {
    for (const k of ENV_VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(root, { recursive: true, force: true });
  }
});
