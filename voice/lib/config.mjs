// Loads and validates voice settings (config/voice.yml) and Azure credentials (.env).
// The key is never logged, never part of an error, and not enumerable on the result.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { getCareerOpsRoot } from '../../path-resolver.mjs';

export const DEFAULTS = Object.freeze({
  enabled: true,
  locale: 'en-US',
  voice: 'en-US-JennyNeural',
  style: 'friendly',
  style_degree: 1.0,
  rate: '-5%',
  pitch: 'default',
  show_text: true,
  player: 'auto',
  cache: true,
  monthly_char_budget: 450000,
  record_device: 'default',
  record_silence_threshold: '0.15%', // minimum speech level; the real threshold is calibrated on the room noise
  record_stop_silence_s: 3.0,
  record_max_s: 150,
  personas: {},
});

const PLAYERS = ['auto', 'afplay', 'aplay', 'paplay', 'ffplay', 'powershell'];
const LOCALE_RE = /^[a-z]{2,3}-[A-Z]{2}$/;
const RATE_RE = /^[+-]?\d+(\.\d+)?%$/;
const PITCH_RE = /^(default|[+-]?\d+(\.\d+)?(%|st|Hz))$/;
const REGION_RE = /^[a-z0-9]+$/;
const THRESHOLD_RE = /^\d+(\.\d+)?%$/;
export const MAX_RECORD_S = 600;

// Hosts the module may talk to; later features add the speech-to-text host here.
export function isAllowedHost(host, region) {
  if (typeof host !== 'string' || !REGION_RE.test(String(region))) return false;
  return host === `${region}.tts.speech.microsoft.com`;
}

// Minimal KEY=VALUE parser; does not touch process.env.
function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.endsWith(v[0])) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function fail(msg) {
  throw new Error(`voice config: ${msg}`);
}

// Validates one settings object; `partial` allows omitted fields (persona overlays).
function validate(s, where, partial) {
  const has = (k) => !partial || s[k] !== undefined;
  const check = (k, ok, expect) => {
    if (has(k) && !ok(s[k])) fail(`${where}${k} must be ${expect}`);
  };
  check('enabled', (v) => typeof v === 'boolean', 'a boolean');
  check('locale', (v) => typeof v === 'string' && LOCALE_RE.test(v), 'a locale like en-US');
  check('voice', (v) => typeof v === 'string' && v.length > 0, 'a non-empty string');
  check('style', (v) => v === null || typeof v === 'string', 'a string or null');
  check('style_degree', (v) => typeof v === 'number' && v >= 0.01 && v <= 2, 'a number from 0.01 to 2');
  check('rate', (v) => typeof v === 'string' && RATE_RE.test(v), 'a percentage like "-5%"');
  check('pitch', (v) => typeof v === 'string' && PITCH_RE.test(v), 'default or a value like "+5%" or "-2st"');
  check('show_text', (v) => typeof v === 'boolean', 'a boolean');
  check('player', (v) => PLAYERS.includes(v), `one of ${PLAYERS.join('|')}`);
  check('cache', (v) => typeof v === 'boolean', 'a boolean');
  check('monthly_char_budget', (v) => Number.isInteger(v) && v > 0, 'a positive integer');
  // A leading "-" would make sox read the device as an option.
  check('record_device', (v) => typeof v === 'string' && v.length > 0 && !v.startsWith('-'), 'a non-empty device name not starting with "-"');
  check('record_silence_threshold', (v) => typeof v === 'string' && THRESHOLD_RE.test(v) && parseFloat(v) <= 100, 'a percentage from 0% to 100% like "1%"');
  check('record_stop_silence_s', (v) => typeof v === 'number' && v > 0 && v <= 30, 'a number of seconds above 0 and up to 30');
  check('record_max_s', (v) => typeof v === 'number' && v > 0 && v <= MAX_RECORD_S, `a number of seconds above 0 and up to ${MAX_RECORD_S}`);
}

export function loadVoiceConfig({ root } = {}) {
  const dir = root ?? getCareerOpsRoot();

  const ymlPath = join(dir, 'config', 'voice.yml');
  let user = {};
  if (existsSync(ymlPath)) {
    let doc;
    try {
      doc = yaml.load(readFileSync(ymlPath, 'utf8'));
    } catch (e) {
      fail(`config/voice.yml is not valid YAML (${e.reason ?? 'parse error'})`);
    }
    user = doc?.voice ?? {};
    if (typeof user !== 'object' || Array.isArray(user)) fail('"voice" must be a mapping');
  }

  const settings = { ...DEFAULTS, ...user };
  validate(settings, 'voice.', false);
  const personas = settings.personas;
  if (personas === null || typeof personas !== 'object' || Array.isArray(personas)) {
    fail('voice.personas must be a mapping');
  }
  for (const [name, p] of Object.entries(personas)) {
    if (p === null || typeof p !== 'object' || Array.isArray(p)) fail(`voice.personas.${name} must be a mapping`);
    validate(p, `personas.${name}.`, true);
  }

  const envPath = join(dir, '.env');
  const fileEnv = existsSync(envPath) ? parseEnv(readFileSync(envPath, 'utf8')) : {};
  const pick = (name) => (process.env[name] || fileEnv[name] || '').trim();
  const key = pick('AZURE_SPEECH_KEY');
  const region = pick('AZURE_SPEECH_REGION');
  if (!key) fail('AZURE_SPEECH_KEY is not set (put it in .env or the environment)');
  if (!region) fail('AZURE_SPEECH_REGION is not set (put it in .env or the environment)');
  if (!REGION_RE.test(region)) fail('AZURE_SPEECH_REGION must match /^[a-z0-9]+$/');

  const azure = { region, host: `${region}.tts.speech.microsoft.com` };
  Object.defineProperty(azure, 'key', { get: () => key, enumerable: false });

  const persona = (name) => {
    const { personas: _omit, ...base } = settings;
    return { ...base, ...(name ? personas[name] : undefined) };
  };

  return { settings, persona, azure };
}
