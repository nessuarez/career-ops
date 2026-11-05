// doctor, voices and read commands. All side effects come through injectable deps.
import { existsSync, readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute, dirname, basename } from 'node:path';
import { createInterface } from 'node:readline';
import { loadVoiceConfig, MAX_RECORD_S } from './config.mjs';
import { record, wavInfo } from './recorder.mjs';
import { assessAudio, summarizeAssessment, MAX_REST_S } from './assess.mjs';
import { assessAudioContinuous, mergeSegments, loadSpeechSdk } from './assess-sdk.mjs';
import { parseWavHeader, isSpeechReadyWav, convertToWav, checkFfmpeg } from './audio.mjs';
import { listVoices, stylesForVoice } from './azure-tts.mjs';
import { detectPlayer, play } from './player.mjs';
import { monthUsage, appendUsage } from './usage.mjs';
import { createSpeaker, resolvePersona } from './speak.mjs';
import { cleanMarkdown, selectSection, splitParagraphs, splitSentences } from './markdown.mjs';
import { parseSince, loadAssessments, summarizeProgress, formatProgress } from './progress.mjs';

const MAX_REQUEST_CHARS = 3000;
const RATE_RE = /^[+-]?\d+(\.\d+)?%$/;
// Ambient room noise peaks around 0.02; only true digital silence (wrong mic, denied permission) is below this.
const SILENT_PEAK = 0.001;
const DOCTOR_RECORD_S = 2;

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

  await checkMic(line, cfg.settings, deps);

  // ffmpeg only matters for phone files; warn-level like sox.
  const ff = await checkFfmpeg({ spawnImpl: deps.spawnImpl });
  line(ff.ok ? 'ok' : 'warn', ff.ok ? 'ffmpeg found on PATH' : `ffmpeg: ${ff.message}`);

  const month = new Date((deps.now ?? Date.now)()).toISOString().slice(0, 7);
  const used = monthUsage(root, month.replace('-', ''));
  line(used >= s.monthly_char_budget ? 'warn' : 'ok', `usage this month: ${used} of ${s.monthly_char_budget} characters`);
  return failed ? 1 : 0;
}

// sox on PATH plus a short test recording; both only warn, since TTS works without a microphone.
async function checkMic(line, settings, deps) {
  const platform = deps.platform ?? process.platform;
  const recordImpl = deps.recordImpl ?? ((o) => record({ settings, out: o.out, max: o.seconds, spawnImpl: deps.spawnImpl, platform, untilSilence: false }));
  const out = join(tmpdir(), `career-ops-voice-doctor-${process.pid}.wav`);
  try {
    await recordImpl({ out, seconds: DOCTOR_RECORD_S });
    line('ok', 'sox found on PATH');
    const { peak } = wavInfo(out);
    if (peak < SILENT_PEAK) line('warn', `test recording is silent (peak ${peak.toFixed(4)}): wrong microphone or permission denied (Settings > Privacy & security > Microphone), or check record_device`);
    else line('ok', `test recording captured audio (peak ${peak.toFixed(3)})`);
  } catch (e) {
    line('warn', e.code === 'SOX_MISSING' ? `sox: ${e.message}` : `test recording failed: ${e.message}`);
  } finally {
    rmSync(out, { force: true });
  }
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

// --- record ---

function recordingPath(root, out, now) {
  const dir = resolve(root, 'output', 'voice', 'recordings');
  const name = out ?? `recording-${new Date(now).toISOString().replace(/[:.]/g, '-')}.wav`;
  const target = isAbsolute(name) ? resolve(name) : resolve(dir, name);
  if (!isAbsolute(name)) {
    const rel = relative(dir, target);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`--out must stay inside ${dir} (or be an absolute path)`);
  }
  if (!target.toLowerCase().endsWith('.wav')) throw new Error('--out must end in .wav');
  return target;
}

// Records one take into `target` (announced on stdout); deps.recordImpl replaces sox in tests.
async function recordTo({ target, max, deps, stdout, root }) {
  const { settings } = loadVoiceConfig({ root });
  mkdirSync(dirname(target), { recursive: true });
  stdout(`Listening: speak now. Recording stops after ${settings.record_stop_silence_s} s of silence once you have spoken.\n`);
  const seconds = max ?? settings.record_max_s;
  if (deps.recordImpl) return deps.recordImpl({ out: target, seconds });
  return record({ settings, out: target, max: seconds, spawnImpl: deps.spawnImpl, platform: deps.platform ?? process.platform });
}

export async function recordCmd(argv, deps, { stdout, root }) {
  const o = flags(argv, { '--out': 'value', '--max': 'value' });
  const max = o.max !== undefined ? Number(o.max) : undefined;
  if (max !== undefined && !(max > 0 && max <= MAX_RECORD_S)) throw new Error(`--max must be a number of seconds above 0 and up to ${MAX_RECORD_S}, got "${o.max}"`);
  const target = recordingPath(root, o.out, (deps.now ?? Date.now)());
  const r = await recordTo({ target, max, deps, stdout, root });
  stdout(`${r.path}\n${r.durationS.toFixed(1)} s\n`);
  return 0;
}

// --- assess ---

const slug = (name) => name.replace(/\.[^.]*$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'audio';

// Shared by assess and drill: converts if needed, sends to Azure (REST or SDK), counts usage, writes the summary JSON.
// `reference` is the reference text (scripted mode) or undefined (free mode).
async function runAssessment({ audioPath, reference, locale: localeOpt, deps, root, stderr }) {
  const cfg = loadVoiceConfig({ root });
  const s = cfg.settings;
  const locale = localeOpt ?? s.locale;
  const mode = reference ? 'scripted' : 'free';
  const now = (deps.now ?? Date.now)();

  // Anything but 16 kHz mono 16-bit PCM WAV (phone files, other WAV formats) is converted into a temp file.
  let wav = readFileSync(audioPath);
  let header = parseWavHeader(wav);
  const date = new Date(now).toISOString().slice(0, 10);
  let summary;
  const tmpFile = join(root, 'output', 'voice', 'tmp', `assess-${process.pid}-${now}.wav`);
  try {
    if (!isSpeechReadyWav(header)) {
      mkdirSync(dirname(tmpFile), { recursive: true });
      await convertToWav({ input: resolve(audioPath), out: tmpFile, spawnImpl: deps.spawnImpl });
      wav = readFileSync(tmpFile);
      header = parseWavHeader(wav);
      if (!isSpeechReadyWav(header)) throw new Error('ffmpeg did not produce a 16 kHz mono WAV');
    }
    const audioS = header.durationS;

    stderr('voice: your recording is sent to Azure Speech for assessment.\n');
    let raw;
    if (audioS <= MAX_REST_S) {
      raw = await assessAudio({ wav, reference, locale, region: cfg.azure.region, key: cfg.azure.key, fetchImpl: deps.fetchImpl ?? fetch });
    } else {
      const sdk = deps.speechSdk ?? (await loadSpeechSdk(deps.importSdk));
      raw = mergeSegments(await assessAudioContinuous({ wav, reference, locale, region: cfg.azure.region, key: cfg.azure.key, sdk }), { reference });
    }
    appendUsage({ root, date, operation: 'assess', seconds: Math.round(audioS * 10) / 10 });
    summary = summarizeAssessment(raw, {
      mode,
      locale,
      thresholds: { accuracyMin: s.assess_accuracy_min, prosodyMin: s.assess_prosody_min, wpmMin: s.assess_wpm_min, wpmMax: s.assess_wpm_max, longPauseS: s.assess_long_pause_s, maxWords: s.assess_max_words },
    });
  } finally {
    rmSync(tmpFile, { force: true });
  }

  const dir = resolve(root, 'output', 'voice', 'assessments');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${date}-${slug(basename(audioPath))}.json`);
  writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`);
  return { file, summary };
}

export async function assessCmd(argv, deps, { stdout, stderr, root }) {
  const o = flags(argv, { '--audio': 'value', '--reference-file': 'value', '--locale': 'value' });
  if (!o.audio) throw new Error('assess needs --audio <file>');
  if (!existsSync(o.audio)) throw new Error(`audio file not found: ${o.audio}`);
  let reference;
  if (o.referenceFile !== undefined) {
    if (!existsSync(o.referenceFile)) throw new Error(`reference file not found: ${o.referenceFile}`);
    reference = readFileSync(o.referenceFile, 'utf8').trim();
    if (!reference) throw new Error('reference file is empty');
  }
  const { file } = await runAssessment({ audioPath: o.audio, reference, locale: o.locale, deps, root, stderr });
  stdout(`${file}\n`);
  return 0;
}

// --- drill ---

const r1 = (n) => (typeof n === 'number' ? String(Math.round(n * 10) / 10) : '-');

function formatDrillSummary(s) {
  const sc = s.scores ?? {};
  const lines = [['pronunciation', 'accuracy', 'fluency', 'prosody', 'completeness'].filter((k) => k in sc).map((k) => `${k} ${r1(sc[k])}`).join(' | ')];
  lines.push(`pace ${s.timing?.wpm ?? '-'} wpm`);
  const fix = (s.words_to_fix ?? []).map((w) => `${w.word} (${r1(w.accuracy)}${w.worst_phonemes?.[0] ? `, ${w.worst_phonemes[0].phoneme}` : ''})`);
  if (fix.length) lines.push(`words to fix: ${fix.join(', ')}`);
  return `${lines.join('\n')}\n`;
}

export async function drillCmd(argv, deps, { stdout, stderr, root }) {
  const o = flags(argv, { '--reference-file': 'value', '--listen-first': 'bool', '--persona': 'value', '--locale': 'value' });
  if (!o.referenceFile) throw new Error('drill needs --reference-file <path>');
  if (!existsSync(o.referenceFile)) throw new Error(`reference file not found: ${o.referenceFile}`);
  const reference = cleanMarkdown(readFileSync(o.referenceFile, 'utf8')).trim();
  if (!reference) throw new Error('nothing to practice after cleaning the reference file (it is empty)');
  const { settings } = loadVoiceConfig({ root });

  if (o.listenFirst) await readCmd(['--file', o.referenceFile, ...(o.persona !== undefined ? ['--persona', o.persona] : [])], deps, { stdout, stderr, root });

  const target = recordingPath(root, undefined, (deps.now ?? Date.now)());
  const rec = await recordTo({ target, deps, stdout, root });
  let result;
  try {
    result = await runAssessment({ audioPath: rec.path ?? target, reference, locale: o.locale, deps, root, stderr });
  } finally {
    if (!settings.keep_recordings) rmSync(rec.path ?? target, { force: true });
  }
  stdout(`${result.file}\n${formatDrillSummary(result.summary)}`);
  return 0;
}

// --- progress ---

export async function progressCmd(argv, deps, { stdout, stderr, root }) {
  const o = flags(argv, { '--since': 'value', '--json': 'bool' });
  const since = parseSince(o.since, (deps.now ?? Date.now)());
  const result = summarizeProgress(loadAssessments(root, since, { warn: (m) => stderr(`voice: ${m}\n`) }));
  stdout(o.json ? `${JSON.stringify({ since, ...result }, null, 2)}\n` : formatProgress(result, since));
  return 0;
}
