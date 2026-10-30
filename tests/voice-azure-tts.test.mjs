import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSsml, synthesize, listVoices, stylesForVoice } from '../voice/lib/azure-tts.mjs';

const KEY = 'fake-key-0123456789abcdef';
const base = {
  text: 'Tell me about yourself.',
  locale: 'en-US',
  voice: 'en-US-JennyNeural',
  style: null,
  styleDegree: 1.0,
  rate: '0%',
  pitch: 'default',
  supportedStyles: ['friendly', 'cheerful'],
};

// Minimal fetch double: replays queued responses and records calls.
function fakeFetch(...responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const r = responses.shift() ?? { status: 200, body: '' };
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)),
      json: async () => r.body,
      arrayBuffer: async () => new Uint8Array(r.bytes ?? [1, 2, 3]).buffer,
    };
  };
  fn.calls = calls;
  return fn;
}

// ---- buildSsml ----

test('SSML snapshot: plain voice, no style, default prosody', () => {
  const { ssml, warnings } = buildSsml(base);
  assert.equal(
    ssml,
    '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" ' +
      'xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="en-US">' +
      '<voice name="en-US-JennyNeural">Tell me about yourself.</voice></speak>',
  );
  assert.deepEqual(warnings, []);
});

test('SSML escapes & < > " \' and neutralises tag injection in text', () => {
  const { ssml } = buildSsml({ ...base, text: `A & B < C > "D" 'E' </voice><voice name="x">pwn` });
  assert.ok(ssml.includes('A &amp; B &lt; C &gt; &quot;D&quot; &apos;E&apos; &lt;/voice&gt;&lt;voice name=&quot;x&quot;&gt;pwn'));
  assert.equal(ssml.match(/<voice /g).length, 1);
});

test('voice, locale and style values that could inject markup are rejected', () => {
  assert.throws(() => buildSsml({ ...base, voice: 'x"><evil/>' }), /voice/);
  assert.throws(() => buildSsml({ ...base, locale: 'en-US"><evil/>' }), /locale/);
  assert.throws(
    () => buildSsml({ ...base, style: 'friendly"/><evil/>', supportedStyles: ['friendly"/><evil/>'] }),
    /style/,
  );
  assert.throws(() => buildSsml({ ...base, rate: '5%"><evil/>' }), /rate/);
  assert.throws(() => buildSsml({ ...base, pitch: '<x>' }), /pitch/);
});

test('unsupported style is omitted with a warning, not an error', () => {
  const { ssml, warnings } = buildSsml({ ...base, style: 'angry' });
  assert.ok(!ssml.includes('express-as'));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /angry/);
});

test('supported style is emitted with styledegree', () => {
  const { ssml, warnings } = buildSsml({ ...base, style: 'friendly', styleDegree: 1.5 });
  assert.ok(ssml.includes('<mstts:express-as style="friendly" styledegree="1.5">Tell me about yourself.</mstts:express-as>'));
  assert.deepEqual(warnings, []);
});

test('prosody is emitted only for non-default values, inside express-as', () => {
  assert.ok(!buildSsml({ ...base, rate: '0%', pitch: 'default' }).ssml.includes('prosody'));
  assert.ok(buildSsml({ ...base, rate: '-5%' }).ssml.includes('<prosody rate="-5%">Tell'));
  assert.ok(buildSsml({ ...base, pitch: '+2st' }).ssml.includes('<prosody pitch="+2st">Tell'));
  const both = buildSsml({ ...base, style: 'cheerful', rate: '-5%', pitch: '+2st' }).ssml;
  assert.ok(both.includes('<mstts:express-as style="cheerful" styledegree="1"><prosody rate="-5%" pitch="+2st">Tell me about yourself.</prosody></mstts:express-as>'));
});

// ---- synthesize ----

const synthArgs = (fetchImpl, extra = {}) => ({
  ssml: '<speak/>',
  region: 'northeurope',
  key: KEY,
  fetchImpl,
  sleep: async () => {},
  ...extra,
});

test('synthesize posts to the regional endpoint with the right headers and returns a Buffer', async () => {
  const f = fakeFetch({ status: 200, bytes: [82, 73, 70, 70] });
  const buf = await synthesize(synthArgs(f));
  assert.ok(Buffer.isBuffer(buf));
  assert.deepEqual([...buf], [82, 73, 70, 70]);
  const { url, init } = f.calls[0];
  assert.equal(url, 'https://northeurope.tts.speech.microsoft.com/cognitiveservices/v1');
  assert.equal(init.method, 'POST');
  assert.equal(init.body, '<speak/>');
  assert.equal(init.headers['Ocp-Apim-Subscription-Key'], KEY);
  assert.equal(init.headers['Content-Type'], 'application/ssml+xml');
  assert.equal(init.headers['X-Microsoft-OutputFormat'], 'riff-24khz-16bit-mono-pcm');
  assert.equal(init.headers['User-Agent'], 'career-ops-voice');
});

test('disallowed region/host is refused without calling fetch', async () => {
  for (const region of ['evil.com/x', 'a.b', '', 'NorthEurope']) {
    const f = fakeFetch({ status: 200 });
    await assert.rejects(synthesize(synthArgs(f, { region })), /host|region/i);
    assert.equal(f.calls.length, 0);
  }
});

test('401 gives a clear key/region message without leaking the key', async () => {
  const f = fakeFetch({ status: 401, body: `denied for ${KEY}` });
  await assert.rejects(synthesize(synthArgs(f)), (e) => {
    assert.match(e.message, /401/);
    assert.match(e.message, /key|region/i);
    assert.ok(!e.message.includes(KEY));
    return true;
  });
});

test('429 retries once after a wait, then succeeds', async () => {
  const waits = [];
  const f = fakeFetch({ status: 429 }, { status: 200, bytes: [9] });
  const buf = await synthesize(synthArgs(f, { sleep: async (ms) => waits.push(ms) }));
  assert.deepEqual([...buf], [9]);
  assert.equal(f.calls.length, 2);
  assert.equal(waits.length, 1);
});

test('429 twice fails after exactly one retry', async () => {
  const f = fakeFetch({ status: 429 }, { status: 429 }, { status: 200 });
  await assert.rejects(synthesize(synthArgs(f)), /429/);
  assert.equal(f.calls.length, 2);
});

test('400 includes the rejected SSML but not the key', async () => {
  const f = fakeFetch({ status: 400, body: 'bad ssml' });
  await assert.rejects(synthesize(synthArgs(f, { ssml: '<speak>oops</speak>' })), (e) => {
    assert.match(e.message, /400/);
    assert.ok(e.message.includes('<speak>oops</speak>'));
    assert.ok(!e.message.includes(KEY));
    return true;
  });
});

test('network errors do not leak the key', async () => {
  const f = async () => {
    throw new Error(`socket hang up (${KEY})`);
  };
  await assert.rejects(synthesize(synthArgs(f)), (e) => !e.message.includes(KEY));
});

// ---- listVoices ----

const VOICES = [
  { ShortName: 'en-US-JennyNeural', Locale: 'en-US', StyleList: ['friendly', 'cheerful'] },
  { ShortName: 'en-US-JennyMultilingualNeural', Locale: 'en-US' },
];
const NOW = Date.UTC(2026, 9, 30);
const DAY = 24 * 60 * 60 * 1000;

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'voice-tts-'));
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test('listVoices: cache miss fetches, writes voices.json and returns the array', () =>
  withDir(async (cacheDir) => {
    const f = fakeFetch({ status: 200, body: VOICES });
    const out = await listVoices({ region: 'northeurope', key: KEY, cacheDir, now: NOW, fetchImpl: f });
    assert.deepEqual(out, VOICES);
    assert.equal(f.calls[0].url, 'https://northeurope.tts.speech.microsoft.com/cognitiveservices/voices/list');
    assert.equal(f.calls[0].init.headers['Ocp-Apim-Subscription-Key'], KEY);
    assert.ok(existsSync(join(cacheDir, 'voices.json')));
    assert.ok(!readFileSync(join(cacheDir, 'voices.json'), 'utf8').includes(KEY));
  }));

test('listVoices: fresh cache is used without fetching', () =>
  withDir(async (cacheDir) => {
    await listVoices({ region: 'northeurope', key: KEY, cacheDir, now: NOW, fetchImpl: fakeFetch({ status: 200, body: VOICES }) });
    const f = fakeFetch();
    const out = await listVoices({ region: 'northeurope', key: KEY, cacheDir, now: NOW + 6 * DAY, fetchImpl: f });
    assert.deepEqual(out, VOICES);
    assert.equal(f.calls.length, 0);
  }));

test('listVoices: stale cache (over 7 days) or corrupt file refetches', () =>
  withDir(async (cacheDir) => {
    await listVoices({ region: 'northeurope', key: KEY, cacheDir, now: NOW, fetchImpl: fakeFetch({ status: 200, body: VOICES }) });
    const f = fakeFetch({ status: 200, body: [VOICES[0]] });
    const out = await listVoices({ region: 'northeurope', key: KEY, cacheDir, now: NOW + 8 * DAY, fetchImpl: f });
    assert.deepEqual(out, [VOICES[0]]);
    assert.equal(f.calls.length, 1);
    writeFileSync(join(cacheDir, 'voices.json'), '{not json');
    const g = fakeFetch({ status: 200, body: VOICES });
    assert.deepEqual(await listVoices({ region: 'northeurope', key: KEY, cacheDir, now: NOW + 8 * DAY, fetchImpl: g }), VOICES);
    assert.equal(g.calls.length, 1);
  }));

test('listVoices: disallowed host refused; 401 is clear and keyless', () =>
  withDir(async (cacheDir) => {
    const f = fakeFetch({ status: 200, body: VOICES });
    await assert.rejects(listVoices({ region: 'evil.com', key: KEY, cacheDir, now: NOW, fetchImpl: f }), /host|region/i);
    assert.equal(f.calls.length, 0);
    await assert.rejects(
      listVoices({ region: 'northeurope', key: KEY, cacheDir, now: NOW, fetchImpl: fakeFetch({ status: 401, body: KEY }) }),
      (e) => /401/.test(e.message) && !e.message.includes(KEY),
    );
  }));

test('stylesForVoice returns the StyleList, or [] when absent or unknown', () => {
  assert.deepEqual(stylesForVoice(VOICES, 'en-US-JennyNeural'), ['friendly', 'cheerful']);
  assert.deepEqual(stylesForVoice(VOICES, 'en-US-JennyMultilingualNeural'), []);
  assert.deepEqual(stylesForVoice(VOICES, 'nope'), []);
});
