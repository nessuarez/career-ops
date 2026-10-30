import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { main } from '../voice/voice.mjs';
import { cleanMarkdown, selectSection, splitParagraphs, splitSentences } from '../voice/lib/markdown.mjs';

const KEY = 'fake-key-0123456789abcdef';
const ENV_VARS = ['AZURE_SPEECH_KEY', 'AZURE_SPEECH_REGION'];
const NOW = Date.parse('2026-10-30T10:00:00Z');

// Minimal valid WAV: 44-byte header + pcm.
function makeWav(pcm) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(24000, 24);
  h.writeUInt32LE(48000, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

const MD = [
  '# Prep',
  '',
  '## Walk me through your background',
  '',
  'I started as an **engineer** and moved to *data*. See [my site](https://x.test).',
  '',
  '<!-- hidden note -->',
  '',
  'Second paragraph here.',
  '',
  '### Detail',
  '',
  'Nested detail text.',
  '',
  '## Why this company',
  '',
  'Because of the mission.',
  '',
].join('\n');

async function run(setup, { md = MD, yml, status = 200, spawnCode = 0, env } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'voice-read-'));
  const saved = Object.fromEntries(ENV_VARS.map((k) => [k, process.env[k]]));
  ENV_VARS.forEach((k) => delete process.env[k]);
  try {
    writeFileSync(join(root, '.env'), env ?? `AZURE_SPEECH_KEY=${KEY}\nAZURE_SPEECH_REGION=northeurope\n`);
    if (yml) {
      mkdirSync(join(root, 'config'));
      writeFileSync(join(root, 'config', 'voice.yml'), yml);
    }
    const file = join(root, 'prep.md');
    writeFileSync(file, md);
    const fetched = [];
    const spawned = [];
    const out = [];
    const err = [];
    const sleeps = [];
    let reads = 0;
    const deps = {
      root,
      now: () => NOW,
      platform: 'darwin',
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
      sleep: async (ms) => sleeps.push(ms),
      readLine: async () => {
        reads++;
        return '';
      },
      fetchImpl: async (url, init) => {
        fetched.push({ url, init });
        if (String(url).includes('voices/list')) {
          return { ok: true, status: 200, json: async () => [{ ShortName: 'en-US-JennyNeural', StyleList: ['friendly'] }] };
        }
        // PCM is derived from the SSML length so every paragraph differs.
        const pcm = Buffer.alloc(4 + (String(init.body).length % 7) * 2, 1);
        return { ok: status === 200, status, arrayBuffer: async () => makeWav(pcm) };
      },
      spawnImpl: (cmd, a) => {
        spawned.push({ cmd, args: a });
        const ee = new EventEmitter();
        setImmediate(() => ee.emit('close', spawnCode));
        return ee;
      },
    };
    const result = await setup({ root, file, deps });
    const usageFile = join(root, 'data', 'voice-usage.tsv');
    return { ...result, root, fetched, spawned, sleeps, reads: () => reads, out: out.join(''), err: err.join(''), usage: existsSync(usageFile) ? readFileSync(usageFile, 'utf8') : '' };
  } finally {
    for (const k of ENV_VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(root, { recursive: true, force: true });
  }
}

const read = (extra = []) => async ({ file, deps }) => ({ code: await main(['read', '--file', file, ...extra], deps) });
const synth = (r) => r.fetched.filter((f) => String(f.url).endsWith('/cognitiveservices/v1'));

// ---- pure markdown helpers ----

test('cleanMarkdown strips markers, links, comments, tables, fences and bullets', () => {
  const md = [
    '# Title',
    'Some **bold** and *it* and `code` with [a link](http://x.y) and ![alt](img.png).',
    '<!-- gone -->',
    '| a | b |',
    '|---|---|',
    '| 1 | 2 |',
    '```js',
    'const secret = 1;',
    '```',
    '- first item',
    '* second item',
    '1. numbered',
    '> quoted',
    '---',
    'tail <!-- multi',
    'line --> end',
  ].join('\n');
  const out = cleanMarkdown(md);
  assert.ok(out.includes('Title'));
  assert.ok(out.includes('Some bold and it and code with a link and alt.'));
  for (const bad of ['#', '**', '`', 'http', 'gone', '|', 'secret', 'multi', '---', '- first']) assert.ok(!out.includes(bad), `still has ${bad}`);
  for (const good of ['first item', 'second item', 'numbered', 'quoted', 'tail', 'end']) assert.ok(out.includes(good), `lost ${good}`);
});

test('selectSection returns text under a heading until the next same-or-higher level', () => {
  const body = selectSection(MD, 'walk me through your background ');
  assert.ok(body.includes('Second paragraph here.'));
  assert.ok(body.includes('Nested detail text.'), 'deeper headings stay inside');
  assert.ok(!body.includes('Because of the mission'));
  assert.ok(!body.includes('Walk me through'), 'the title itself is not read');
  assert.throws(() => selectSection(MD, 'Nope'), (e) => /Nope/.test(e.message) && /Why this company/.test(e.message) && /Prep/.test(e.message));
});

test('selectSection ignores headings inside code fences', () => {
  const md = '## A\n```\n## B\n```\ntext\n## C\nmore';
  assert.ok(selectSection(md, 'A').includes('text'));
  assert.throws(() => selectSection(md, 'B'), /available/i);
});

test('splitParagraphs splits on blank lines and drops empty ones; splitSentences respects the limit', () => {
  assert.deepEqual(splitParagraphs('one\ntwo\n\n\n  \nthree'), ['one two', 'three']);
  const long = 'First sentence here. Second sentence here! Third one? Fourth.';
  const parts = splitSentences(long, 30);
  assert.ok(parts.length >= 2);
  assert.ok(parts.every((p) => p.length <= 30));
  assert.equal(parts.join(' '), long);
  assert.deepEqual(splitSentences('short.', 30), ['short.']);
  const noStops = splitSentences('word '.repeat(20).trim(), 30);
  assert.ok(noStops.every((p) => p.length <= 30));
});

// ---- read command ----

test('read synthesizes one request per cleaned paragraph, prints index and wav path, records usage', async () => {
  const r = await run(read(['--no-play']));
  assert.equal(r.code, 0);
  assert.equal(synth(r).length, 8, 'headings and body paragraphs');
  const lines = r.out.trim().split('\n');
  assert.equal(lines.length, 8);
  assert.match(lines[0], /^1\/8.*output[\\/]voice[\\/]cache[\\/][0-9a-f]{64}\.wav$/);
  assert.ok(synth(r).every((f) => !f.init.body.includes('**') && !f.init.body.includes('hidden note')));
  assert.equal(r.usage.trim().split('\n').length, 9);
  assert.match(r.usage, /\tread\t/);
  assert.equal(r.spawned.length, 0);
});

test('--section reads only that section and unknown sections list the headings', async () => {
  const r = await run(read(['--no-play', '--section', 'why this company']));
  assert.equal(r.code, 0);
  assert.equal(synth(r).length, 1);
  assert.ok(synth(r)[0].init.body.includes('Because of the mission.'));
  const bad = await run(read(['--no-play', '--section', 'Missing']));
  assert.equal(bad.code, 1);
  assert.match(bad.err, /Why this company/);
  assert.equal(synth(bad).length, 0);
});

test('--rate overrides the rate for the run and changes the cache key', async () => {
  const r = await run(async (ctx) => {
    const a = await read(['--no-play', '--section', 'why this company'])(ctx);
    const first = ctx.deps.stdout;
    const b = await read(['--no-play', '--section', 'why this company', '--rate', '-15%'])(ctx);
    return { a, b };
  });
  assert.equal(synth(r).length, 2, 'different rate is a different cache entry');
  assert.ok(synth(r)[1].init.body.includes('rate="-15%"'));
  const lines = r.out.trim().split('\n');
  assert.notEqual(lines[0].split(' ')[1], lines[1].split(' ')[1]);
});

test('an invalid --rate or --pause is rejected', async () => {
  const a = await run(read(['--no-play', '--rate', 'fast']));
  assert.equal(a.code, 1);
  const b = await run(read(['--pause', 'soon']));
  assert.equal(b.code, 1);
  assert.equal(synth(b).length, 0);
});

test('a second read is served from cache and adds no usage', async () => {
  const r = await run(async (ctx) => {
    await read(['--no-play'])(ctx);
    const usage1 = readFileSync(join(ctx.root, 'data', 'voice-usage.tsv'), 'utf8');
    await read(['--no-play'])(ctx);
    return { usage1 };
  });
  assert.equal(synth(r).length, 8);
  assert.equal(r.usage, r.usage1);
});

test('plays every paragraph and uses the injected sleep for --pause (not after the last one)', async () => {
  const r = await run(read(['--section', 'walk me through your background', '--pause', '2s']));
  assert.equal(r.code, 0);
  assert.equal(r.spawned.length, 4);
  assert.deepEqual(r.sleeps, [2000, 2000, 2000]);
  const ms = await run(read(['--section', 'why this company', '--pause', '500ms']));
  assert.deepEqual(ms.sleeps, []);
  const m2 = await run(read(['--section', 'walk me through your background', '--pause', '500ms']));
  assert.deepEqual(m2.sleeps, [500, 500, 500]);
});

test('--step waits on the injected readLine between paragraphs', async () => {
  const r = await run(read(['--section', 'walk me through your background', '--step']));
  assert.equal(r.code, 0);
  assert.equal(r.reads(), 3);
  assert.equal(r.spawned.length, 4);
});

test('long paragraphs are split at sentence boundaries into separate requests', async () => {
  const sentence = 'This sentence is about forty characters.';
  const md = `${Array(200).fill(sentence).join(' ')}\n`;
  const r = await run(read(['--no-play']), { md });
  assert.equal(r.code, 0);
  assert.ok(synth(r).length >= 2);
  assert.ok(synth(r).every((f) => f.init.body.length < 4000 + 600));
});

test('--out writes one valid concatenated WAV under output/voice/exports', async () => {
  const r = await run(async (ctx) => {
    const code = await main(['read', '--file', ctx.file, '--no-play', '--section', 'walk me through your background', '--out', 'bg.wav'], ctx.deps);
    const target = join(ctx.root, 'output', 'voice', 'exports', 'bg.wav');
    return { code, buf: readFileSync(target) };
  });
  assert.equal(r.code, 0);
  const b = r.buf;
  assert.equal(b.toString('ascii', 0, 4), 'RIFF');
  assert.equal(b.toString('ascii', 36, 40), 'data');
  assert.equal(b.readUInt32LE(4), b.length - 8);
  assert.equal(b.readUInt32LE(40), b.length - 44);
  assert.equal(b.readUInt32LE(24), 24000);
  assert.match(r.out, /exports[\\/]bg\.wav/);
});

test('--out refuses relative paths that escape the exports folder and non-wav names', async () => {
  const a = await run(read(['--no-play', '--out', '../escape.wav']));
  assert.equal(a.code, 1);
  assert.match(a.err, /exports/);
  const b = await run(read(['--no-play', '--out', 'notes.txt']));
  assert.equal(b.code, 1);
  assert.match(b.err, /\.wav/);
});

test('persona: defaults to me when defined, --persona overrides, unknown names the file to create', async () => {
  const yml = 'voice:\n  personas:\n    me: { voice: en-US-GuyNeural, style: null }\n    hm: { voice: en-US-AriaNeural, style: null }\n';
  const a = await run(read(['--no-play', '--section', 'why this company']), { yml });
  assert.ok(synth(a)[0].init.body.includes('voice name="en-US-GuyNeural"'));
  const b = await run(read(['--no-play', '--section', 'why this company', '--persona', 'hm']), { yml });
  assert.ok(synth(b)[0].init.body.includes('voice name="en-US-AriaNeural"'));
  const c = await run(read(['--no-play', '--persona', 'zzz']));
  assert.equal(c.code, 1);
  assert.match(c.err, /zzz/);
  assert.match(c.err, /voice\.yml/);
  const d = await run(read(['--no-play', '--section', 'why this company']));
  assert.ok(synth(d)[0].init.body.includes('voice name="en-US-JennyNeural"'));
});

test('read errors never contain the key', async () => {
  const r = await run(read(['--no-play']), { status: 401 });
  assert.equal(r.code, 1);
  assert.ok(!r.err.includes(KEY) && !r.out.includes(KEY));
  const missing = await run(({ deps }) => main(['read', '--file', 'nope.md'], deps).then((code) => ({ code })));
  assert.equal(missing.code, 1);
  assert.match(missing.err, /not found/);
});
