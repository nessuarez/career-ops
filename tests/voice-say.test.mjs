import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { main } from '../voice/voice.mjs';

const KEY = 'fake-key-0123456789abcdef';
const ENV_VARS = ['AZURE_SPEECH_KEY', 'AZURE_SPEECH_REGION'];
const NOW = Date.parse('2026-10-30T10:00:00Z');

function res(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () => Buffer.from(body),
    json: async () => body,
  };
}

// Harness: temp root, fake fetch/spawn, captured output. Env vars are saved/restored.
async function run(setup, args, { yml, text, spawnCode = 0, status = 200 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'voice-say-'));
  const saved = Object.fromEntries(ENV_VARS.map((k) => [k, process.env[k]]));
  ENV_VARS.forEach((k) => delete process.env[k]);
  try {
    writeFileSync(join(root, '.env'), `AZURE_SPEECH_KEY=${KEY}\nAZURE_SPEECH_REGION=northeurope\n`);
    if (yml) {
      mkdirSync(join(root, 'config'));
      writeFileSync(join(root, 'config', 'voice.yml'), yml);
    }
    const textFile = join(root, 'q.txt');
    if (text !== undefined) writeFileSync(textFile, text);
    const fetched = [];
    const spawned = [];
    const out = [];
    const err = [];
    const deps = {
      root,
      now: () => NOW,
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
      fetchImpl: async (url, init) => {
        fetched.push({ url, init });
        if (String(url).includes('voices/list')) {
          return res([{ ShortName: 'en-US-JennyNeural', StyleList: ['friendly', 'chat'] }]);
        }
        return res('RIFFwav', status);
      },
      spawnImpl: (cmd, a, opts) => {
        spawned.push({ cmd, args: a, opts });
        const ee = new EventEmitter();
        setImmediate(() => ee.emit('close', spawnCode));
        return ee;
      },
      platform: 'darwin',
    };
    const result = await setup({ root, textFile, deps, args });
    return { ...result, root, fetched, spawned, out, err, textFile };
  } finally {
    for (const k of ENV_VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(root, { recursive: true, force: true });
  }
}

const say = (extra = []) => ({ root, textFile, deps }) =>
  main(['say', '--text-file', textFile, ...extra], deps).then((code) => ({ code, usage: usageOf(root) }));

const synthCalls = (r) => r.fetched.filter((f) => String(f.url).endsWith('/cognitiveservices/v1'));
const usageOf = (root) => {
  const f = join(root, 'data', 'voice-usage.tsv');
  return existsSync(f) ? readFileSync(f, 'utf8') : '';
};

test('say happy path: synthesizes once, caches, records usage and plays the wav', async () => {
  const r = await run(say(), null, { text: 'Tell me about yourself.' });
  assert.equal(r.code, 0);
  assert.equal(synthCalls(r).length, 1);
  assert.equal(r.spawned.length, 1);
  const wav = r.out.join('').trim();
  assert.match(wav, /output[\\/]voice[\\/]cache[\\/][0-9a-f]{64}\.wav$/);
  assert.equal(r.out.join('').trim().split('\n').length, 1, 'single stdout line');
  assert.deepEqual(r.spawned[0].args, [wav]);
  assert.match(r.usage, /2026-10-30\tsay\t23\t/);
});

test('second say of the same text is a cache hit with no fetch and no usage', async () => {
  const r = await run(
    async (ctx) => {
      await say()(ctx);
      return { usage1: usageOf(ctx.root), code: (await say()(ctx)).code, usage2: usageOf(ctx.root) };
    },
    null,
    { text: 'Same question?' },
  );
  assert.equal(r.code, 0);
  assert.equal(synthCalls(r).length, 1, 'only the first say synthesizes');
  assert.equal(r.spawned.length, 2, 'both plays happen');
  assert.equal(r.usage1.trim().split('\n').length, 2, 'header plus one row');
  assert.equal(r.usage2, r.usage1, 'cache hit adds no usage');
});

test('--no-play and enabled:false skip playback', async () => {
  const a = await run(say(['--no-play']), null, { text: 'Hello' });
  assert.equal(a.code, 0);
  assert.equal(a.spawned.length, 0);
  const b = await run(say(), null, { text: 'Hello', yml: 'voice:\n  enabled: false\n' });
  assert.equal(b.code, 0);
  assert.equal(b.spawned.length, 0);
  assert.equal(synthCalls(b).length, 1);
});

test('text file missing, empty or too long is an error with exit 1', async () => {
  const missing = await run(say(), null, {});
  assert.equal(missing.code, 1);
  assert.match(missing.err.join(''), /text file/i);
  const empty = await run(say(), null, { text: '  \n ' });
  assert.equal(empty.code, 1);
  assert.match(empty.err.join(''), /empty/i);
  const long = await run(say(), null, { text: 'a'.repeat(5001) });
  assert.equal(long.code, 1);
  assert.match(long.err.join(''), /read/);
  assert.equal(synthCalls(long).length, 0);
});

test('unsupported style warns once and still succeeds', async () => {
  const r = await run(say(), null, { text: 'Hi', yml: 'voice:\n  style: whispering\n' });
  assert.equal(r.code, 0);
  assert.equal(r.err.join('').match(/not supported/g)?.length, 1);
  const body = synthCalls(r)[0].init.body;
  assert.ok(!body.includes('express-as'));
});

test('supported style is applied to the SSML', async () => {
  const r = await run(say(), null, { text: 'Hi' });
  assert.ok(synthCalls(r)[0].init.body.includes('mstts:express-as style="friendly"'));
});

test('persona overlay changes the voice and escapes text', async () => {
  const yml = 'voice:\n  personas:\n    hm: { voice: en-US-GuyNeural, style: null }\n';
  const r = await run(say(['--persona', 'hm']), null, { text: 'A < B & "C"', yml });
  assert.equal(r.code, 0);
  const body = synthCalls(r)[0].init.body;
  assert.ok(body.includes('voice name="en-US-GuyNeural"'));
  assert.ok(body.includes('A &lt; B &amp; &quot;C&quot;'));
  const bad = await run(say(['--persona', 'nope']), null, { text: 'Hi' });
  assert.equal(bad.code, 1);
  assert.match(bad.err.join(''), /persona/i);
});

test('budget warning at 90 percent of the monthly budget', async () => {
  const r = await run(say(), null, { text: 'x'.repeat(95), yml: 'voice:\n  monthly_char_budget: 100\n' });
  assert.equal(r.code, 0);
  assert.match(r.err.join(''), /90/);
});

test('errors never contain the key', async () => {
  const r = await run(say(), null, { text: 'Hi', status: 401 });
  assert.equal(r.code, 1);
  assert.ok(!r.err.join('').includes(KEY));
  assert.ok(!r.out.join('').includes(KEY));
});

test('future commands print not implemented yet and exit 1', async () => {
  const r = await run(({ deps }) => main(['doctor'], deps).then((code) => ({ code })), null, {});
  assert.equal(r.code, 1);
  assert.match(r.err.join(''), /not implemented yet/);
});
