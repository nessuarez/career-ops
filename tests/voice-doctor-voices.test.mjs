import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../voice/voice.mjs';

const KEY = 'fake-key-0123456789abcdef';
const ENV_VARS = ['AZURE_SPEECH_KEY', 'AZURE_SPEECH_REGION'];
const NOW = Date.parse('2026-10-30T10:00:00Z');
const VOICES = [
  { ShortName: 'en-US-JennyNeural', Locale: 'en-US', Gender: 'Female', StyleList: ['friendly', 'chat'] },
  { ShortName: 'en-US-GuyNeural', Locale: 'en-US', Gender: 'Male', StyleList: [] },
  { ShortName: 'es-ES-ElviraNeural', Locale: 'es-ES', Gender: 'Female' },
];

async function run(args, { yml, env = `AZURE_SPEECH_KEY=${KEY}\nAZURE_SPEECH_REGION=northeurope\n`, status = 200, usage } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'voice-dv-'));
  const saved = Object.fromEntries(ENV_VARS.map((k) => [k, process.env[k]]));
  ENV_VARS.forEach((k) => delete process.env[k]);
  try {
    writeFileSync(join(root, '.env'), env);
    if (yml) {
      mkdirSync(join(root, 'config'));
      writeFileSync(join(root, 'config', 'voice.yml'), yml);
    }
    if (usage) {
      mkdirSync(join(root, 'data'));
      writeFileSync(join(root, 'data', 'voice-usage.tsv'), `date\toperation\tchars\tseconds\n2026-10-05\tsay\t${usage}\t\n`);
    }
    const out = [];
    const err = [];
    const deps = {
      root,
      now: () => NOW,
      platform: 'win32',
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
      fetchImpl: async () => ({ ok: status === 200, status, json: async () => VOICES }),
    };
    const code = await main(args, deps);
    return { code, out: out.join(''), err: err.join(''), root };
  } finally {
    for (const k of ENV_VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(root, { recursive: true, force: true });
  }
}

test('doctor passes with a fake voice list and warns about the missing voice.yml', async () => {
  const r = await run(['doctor']);
  assert.equal(r.code, 0);
  assert.match(r.out, /warn.*voice\.yml/i);
  assert.match(r.out, /voice\.example\.yml/);
  assert.match(r.out, /ok.*AZURE_SPEECH_KEY/);
  assert.match(r.out, /ok.*en-US-JennyNeural/);
  assert.match(r.out, /ok.*player/i);
  assert.match(r.out, /ok.*usage/i);
  assert.ok(!r.out.includes(KEY) && !r.err.includes(KEY));
});

test('doctor warns on unsupported style and unknown persona voice, shows usage vs budget', async () => {
  const yml = 'voice:\n  style: whispering\n  monthly_char_budget: 1000\n  personas:\n    me: { voice: en-US-NopeNeural }\n';
  const r = await run(['doctor'], { yml, usage: 250 });
  assert.equal(r.code, 0);
  assert.match(r.out, /warn.*whispering/);
  assert.match(r.out, /warn.*persona me.*en-US-NopeNeural/);
  assert.match(r.out, /250 of 1000/);
  assert.doesNotMatch(r.out, /warn.*voice\.yml/i);
});

test('doctor fails on a missing key without printing any key', async () => {
  const r = await run(['doctor'], { env: 'AZURE_SPEECH_REGION=northeurope\n' });
  assert.equal(r.code, 1);
  assert.match(r.out, /fail.*AZURE_SPEECH_KEY/);
  assert.ok(!r.out.includes(KEY));
});

test('doctor fails when the configured voice is not in the list or the service rejects the key', async () => {
  const a = await run(['doctor'], { yml: 'voice:\n  voice: en-US-GhostNeural\n' });
  assert.equal(a.code, 1);
  assert.match(a.out, /fail.*en-US-GhostNeural/);
  const b = await run(['doctor'], { status: 401 });
  assert.equal(b.code, 1);
  assert.match(b.out, /fail.*voices/i);
  assert.ok(!b.out.includes(KEY));
});

test('voices filters by locale and prints styles with --styles', async () => {
  const r = await run(['voices', '--locale', 'en-US']);
  assert.equal(r.code, 0);
  assert.match(r.out, /en-US-JennyNeural\tFemale\n/);
  assert.match(r.out, /en-US-GuyNeural\tMale\n/);
  assert.ok(!r.out.includes('es-ES'));
  const s = await run(['voices', '--locale', 'en-US', '--styles']);
  assert.match(s.out, /en-US-JennyNeural\tFemale\tfriendly,chat/);
});

test('voices needs --locale and never leaks the key on errors', async () => {
  const a = await run(['voices']);
  assert.equal(a.code, 1);
  assert.match(a.err, /--locale/);
  const b = await run(['voices', '--locale', 'en-US'], { status: 401 });
  assert.equal(b.code, 1);
  assert.ok(!b.err.includes(KEY));
  const c = await run(['voices', '--locale', 'xx-XX']);
  assert.equal(c.code, 1);
  assert.match(c.err, /xx-XX/);
});

test('record, assess, drill, progress and install-skill stay not implemented', async () => {
  for (const c of ['record', 'assess', 'drill', 'progress', 'install-skill']) {
    const r = await run([c]);
    assert.equal(r.code, 1);
    assert.match(r.err, /not implemented yet/);
  }
});
