// doctor, voices and read commands. All side effects come through injectable deps.
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { loadVoiceConfig } from './config.mjs';
import { listVoices, stylesForVoice } from './azure-tts.mjs';
import { detectPlayer, play } from './player.mjs';
import { monthUsage } from './usage.mjs';
import { createSpeaker, resolvePersona } from './speak.mjs';
import { cleanMarkdown, selectSection, splitParagraphs, splitSentences } from './markdown.mjs';

const MAX_REQUEST_CHARS = 3000;
const RATE_RE = /^[+-]?\d+(\.\d+)?%$/;

function flags(argv, spec) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const kind = spec[a];
    if (!kind) throw new Error(`unknown argument "${a}"`);
    const name = a.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase());
    if (kind === 'bool') o[name] = true;
    else if (argv[i + 1] === undefined) throw new Error(`${a} needs a value`);
    else o[name] = argv[++i];
  }
  return o;
}

const voicesCfg = (root, cfg, deps) =>
  listVoices({ region: cfg.azure.region, key: cfg.azure.key, cacheDir: join(root, 'output', 'voice'), now: (deps.now ?? Date.now)(), fetchImpl: deps.fetchImpl ?? fetch });

export async function doctor(argv, deps, { stdout, root }) {
  flags(argv, {});
  let failed = false;
  const line = (level, msg) => {
    if (level === 'fail') failed = true;
    stdout(`${level.padEnd(4)}  ${msg}\n`);
  };
  line('ok', `data root: ${root}`);
  const ymlPath = join(root, 'config', 'voice.yml');
  if (existsSync(ymlPath)) line('ok', 'config/voice.yml present');
  else line('warn', `config/voice.yml missing (using defaults): copy voice/voice.example.yml to ${ymlPath}`);

  let cfg;
  try {
    cfg = loadVoiceConfig({ root });
  } catch (e) {
    line('fail', e.message);
    return 1;
  }
  line('ok', 'AZURE_SPEECH_KEY present (value hidden)');
  line('ok', `AZURE_SPEECH_REGION present (${cfg.azure.region})`);

  let voices;
  try {
    voices = await voicesCfg(root, cfg, deps);
    line('ok', `voices/list reachable (${voices.length} voices)`);
  } catch (e) {
    line('fail', `voices/list: ${e.message}`);
  }

  const s = cfg.persona();
  if (voices) {
    if (voices.some((v) => v.ShortName === s.voice)) line('ok', `voice ${s.voice} exists`);
    else line('fail', `voice ${s.voice} is not in the voice list for this region`);
    if (s.style != null) {
      if (stylesForVoice(voices, s.voice).includes(s.style)) line('ok', `style ${s.style} supported by ${s.voice}`);
      else line('warn', `style ${s.style} is not supported by ${s.voice}; it will be dropped`);
    }
    for (const [name, p] of Object.entries(cfg.settings.personas)) {
      if (p.voice && !voices.some((v) => v.ShortName === p.voice)) line('warn', `persona ${name} voice ${p.voice} is not in the voice list`);
    }
  }

  try {
    line('ok', `player: ${detectPlayer(deps.platform ?? process.platform, s.player).cmd}`);
  } catch (e) {
    line('fail', `player: ${e.message}`);
  }

  const month = new Date((deps.now ?? Date.now)()).toISOString().slice(0, 7);
  const used = monthUsage(root, month.replace('-', ''));
  line(used >= s.monthly_char_budget ? 'warn' : 'ok', `usage this month: ${used} of ${s.monthly_char_budget} characters`);
  return failed ? 1 : 0;
}

export async function voicesCmd(argv, deps, { stdout, root }) {
  const o = flags(argv, { '--locale': 'value', '--styles': 'bool' });
  if (!o.locale) throw new Error('voices needs --locale <xx-XX>');
  const list = (await voicesCfg(root, loadVoiceConfig({ root }), deps)).filter((v) => v.Locale === o.locale);
  if (!list.length) throw new Error(`no voices found for locale ${o.locale}`);
  for (const v of list) stdout(`${[v.ShortName, v.Gender, ...(o.styles ? [(v.StyleList ?? []).join(',')] : [])].join('\t')}\n`);
  return 0;
}

// --- read ---

const parsePause = (v) => {
  const m = String(v).match(/^(\d+(?:\.\d+)?)(ms|s)$/);
  if (!m) throw new Error(`--pause must look like 2s or 500ms, got "${v}"`);
  return Math.round(Number(m[1]) * (m[2] === 's' ? 1000 : 1));
};

function exportPath(root, out) {
  const dir = resolve(root, 'output', 'voice', 'exports');
  const target = isAbsolute(out) ? resolve(out) : resolve(dir, out);
  if (!isAbsolute(out)) {
    const rel = relative(dir, target);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`--out must stay inside ${dir} (or be an absolute path)`);
  }
  if (!target.toLowerCase().endsWith('.wav')) throw new Error('--out must end in .wav');
  return target;
}

// Joins the PCM payloads of several WAVs under the first file's header, with sizes fixed.
export function concatWavs(buffers) {
  const parts = buffers.map((b) => {
    let p = 12;
    while (p + 8 <= b.length) {
      const id = b.toString('ascii', p, p + 4);
      const size = b.readUInt32LE(p + 4);
      if (id === 'data') return { head: b.subarray(0, p + 8), pcm: b.subarray(p + 8, Math.min(b.length, p + 8 + size)) };
      p += 8 + size + (size % 2);
    }
    throw new Error('a synthesized file is not a valid WAV (no data chunk)');
  });
  const pcm = Buffer.concat(parts.map((x) => x.pcm));
  const head = Buffer.from(parts[0].head);
  head.writeUInt32LE(head.length - 8 + pcm.length, 4);
  head.writeUInt32LE(pcm.length, head.length - 4);
  return Buffer.concat([head, pcm]);
}

const defaultReadLine = () =>
  new Promise((res) => {
    const rl = createInterface({ input: process.stdin });
    rl.once('line', (l) => { rl.close(); res(l); });
    rl.once('close', () => res(''));
  });

export async function readCmd(argv, deps, { stdout, stderr, root }) {
  const o = flags(argv, { '--file': 'value', '--section': 'value', '--rate': 'value', '--pause': 'value', '--step': 'bool', '--out': 'value', '--persona': 'value', '--no-play': 'bool' });
  if (!o.file) throw new Error('read needs --file <path.md>');
  if (!existsSync(o.file)) throw new Error(`file not found: ${o.file}`);
  if (o.rate !== undefined && !RATE_RE.test(o.rate)) throw new Error(`--rate must look like -15%, got "${o.rate}"`);
  const pauseMs = o.pause !== undefined ? parsePause(o.pause) : 0;
  const outFile = o.out !== undefined ? exportPath(root, o.out) : null;

  let md = readFileSync(o.file, 'utf8');
  if (o.section !== undefined) md = selectSection(md, o.section);
  const paragraphs = splitParagraphs(cleanMarkdown(md)).flatMap((p) => splitSentences(p, MAX_REQUEST_CHARS));
  if (!paragraphs.length) throw new Error('nothing to read after cleaning the Markdown');

  const cfg = loadVoiceConfig({ root });
  const s = { ...resolvePersona(cfg, o.persona, root, { fallback: 'me' }), ...(o.rate !== undefined ? { rate: o.rate } : {}) };
  const speaker = createSpeaker({ root, cfg, deps, stderr });
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const readLine = deps.readLine ?? defaultReadLine;
  const playing = !o.noPlay && s.enabled;
  const player = playing ? detectPlayer(deps.platform ?? process.platform, s.player) : null;

  const wavs = [];
  for (const [i, text] of paragraphs.entries()) {
    const { wav } = await speaker.wavFor(text, s, 'read');
    wavs.push(wav);
    stdout(`${i + 1}/${paragraphs.length} ${wav}\n`);
    if (playing) {
      await play(wav, { player, spawnImpl: deps.spawnImpl });
      if (i < paragraphs.length - 1) {
        if (pauseMs) await sleep(pauseMs);
        if (o.step) await readLine();
      }
    }
  }
  speaker.budgetWarn(s);

  if (outFile) {
    mkdirSync(dirname(outFile), { recursive: true });
    writeFileSync(outFile, concatWavs(wavs.map((w) => readFileSync(w))));
    stdout(`${outFile}\n`);
  }
  return 0;
}
