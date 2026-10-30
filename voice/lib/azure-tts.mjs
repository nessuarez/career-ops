// Azure Speech TTS client: SSML builder, REST synthesis and the cached voice list.
// The key goes only into the request header; it never appears in errors or logs.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { isAllowedHost } from './config.mjs';

const SAFE_NAME_RE = /^[A-Za-z0-9._-]+$/;
const RATE_RE = /^[+-]?\d+(\.\d+)?%$/;
const PITCH_RE = /^(default|[+-]?\d+(\.\d+)?(%|st|Hz))$/;
const ZERO_RATE_RE = /^[+-]?0+(\.0+)?%$/;
const VOICES_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RETRY_WAIT_MS = 2000;

const XML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
const escapeXml = (s) => String(s).replace(/[&<>"']/g, (c) => XML_ESCAPES[c]);

function requireSafe(value, label, re = SAFE_NAME_RE) {
  if (typeof value !== 'string' || !re.test(value)) throw new Error(`SSML: invalid ${label}`);
  return value;
}

// Returns { ssml, warnings }. An unsupported style is dropped with a warning.
export function buildSsml({ text, locale, voice, style = null, styleDegree = 1, rate = null, pitch = null, supportedStyles = [] }) {
  requireSafe(locale, 'locale');
  requireSafe(voice, 'voice');
  const warnings = [];

  let useStyle = null;
  if (style != null) {
    requireSafe(style, 'style');
    if (supportedStyles.includes(style)) useStyle = style;
    else warnings.push(`style "${style}" is not supported by voice ${voice}; speaking without it`);
  }

  const attrs = [];
  if (rate != null && !ZERO_RATE_RE.test(rate)) attrs.push(`rate="${requireSafe(rate, 'rate', RATE_RE)}"`);
  if (pitch != null && pitch !== 'default') attrs.push(`pitch="${requireSafe(pitch, 'pitch', PITCH_RE)}"`);

  let body = escapeXml(text);
  if (attrs.length) body = `<prosody ${attrs.join(' ')}>${body}</prosody>`;
  if (useStyle) {
    if (typeof styleDegree !== 'number' || !(styleDegree >= 0.01 && styleDegree <= 2)) {
      throw new Error('SSML: invalid styleDegree');
    }
    body = `<mstts:express-as style="${useStyle}" styledegree="${styleDegree}">${body}</mstts:express-as>`;
  }

  const ssml =
    '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" ' +
    `xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${locale}">` +
    `<voice name="${voice}">${body}</voice></speak>`;
  return { ssml, warnings };
}

// Builds the regional URL, refusing any host outside the allow-list before fetching.
function endpoint(region, path) {
  const host = `${region}.tts.speech.microsoft.com`;
  if (!isAllowedHost(host, region)) throw new Error(`refusing to call disallowed host for region "${region}"`);
  return `https://${host}${path}`;
}

const redact = (text, key) => (key ? String(text).split(key).join('[redacted]') : String(text));

async function send(fetchImpl, url, init, key) {
  try {
    return await fetchImpl(url, init);
  } catch (e) {
    throw new Error(`Azure Speech request failed: ${redact(e?.message ?? e, key)}`);
  }
}

function authError(status) {
  return new Error(`Azure Speech returned ${status}: check AZURE_SPEECH_KEY and AZURE_SPEECH_REGION (the key must belong to that region)`);
}

export async function synthesize({ ssml, region, key, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const url = endpoint(region, '/cognitiveservices/v1');
  const init = {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': key,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'riff-24khz-16bit-mono-pcm',
      'User-Agent': 'career-ops-voice',
    },
    body: ssml,
  };

  let res = await send(fetchImpl, url, init, key);
  if (res.status === 429) {
    await sleep(RETRY_WAIT_MS);
    res = await send(fetchImpl, url, init, key);
  }
  if (res.ok) return Buffer.from(await res.arrayBuffer());
  if (res.status === 401) throw authError(401);
  if (res.status === 429) throw new Error('Azure Speech returned 429 (rate limited) twice; wait a minute and retry');
  if (res.status === 400) throw new Error(`Azure Speech rejected the SSML (400). SSML sent:\n${ssml}`);
  throw new Error(`Azure Speech returned ${res.status}`);
}

// Voice catalogue, cached for 7 days in <cacheDir>/voices.json.
export async function listVoices({ region, key, cacheDir, now = Date.now(), fetchImpl = fetch }) {
  const url = endpoint(region, '/cognitiveservices/voices/list');
  const file = join(cacheDir, 'voices.json');
  try {
    const cached = JSON.parse(readFileSync(file, 'utf8'));
    if (Array.isArray(cached.voices) && now - cached.fetchedAt < VOICES_TTL_MS && now >= cached.fetchedAt) {
      return cached.voices;
    }
  } catch {
    // missing or corrupt cache: fetch again
  }

  const res = await send(fetchImpl, url, { headers: { 'Ocp-Apim-Subscription-Key': key, 'User-Agent': 'career-ops-voice' } }, key);
  if (res.status === 401) throw authError(401);
  if (!res.ok) throw new Error(`Azure Speech voices/list returned ${res.status}`);
  const voices = await res.json();
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(file, JSON.stringify({ fetchedAt: now, voices }));
  return voices;
}

export function stylesForVoice(voices, shortName) {
  return voices.find((v) => v.ShortName === shortName)?.StyleList ?? [];
}
