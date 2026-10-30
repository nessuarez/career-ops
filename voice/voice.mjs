// Voice CLI: node voice/voice.mjs say --text-file <path> [--persona <name>] [--no-play]
// Text always comes from a file, never from argv (job-posting content is untrusted).
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadVoiceConfig } from './lib/config.mjs';
import { buildSsml, synthesize, listVoices, stylesForVoice } from './lib/azure-tts.mjs';
import { detectPlayer, play } from './lib/player.mjs';
import { appendUsage, monthUsage, budgetStatus } from './lib/usage.mjs';
import { cacheKey, getCached, putCached } from './lib/cache.mjs';
import { getCareerOpsRoot } from '../path-resolver.mjs';

const MAX_CHARS = 5000;
const FUTURE = ['doctor', 'voices', 'read', 'record', 'install-skill'];

function parseArgs(argv) {
  const o = { noPlay: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-play') o.noPlay = true;
    else if (a === '--text-file') o.textFile = argv[++i];
    else if (a === '--persona') o.persona = argv[++i];
    else throw new Error(`unknown argument "${a}"`);
  }
  return o;
}

async function say(argv, deps, { stdout, stderr }) {
  const opts = parseArgs(argv);
  if (!opts.textFile) throw new Error('say needs --text-file <path>');
  if (!existsSync(opts.textFile)) throw new Error(`text file not found: ${opts.textFile}`);
  const text = readFileSync(opts.textFile, 'utf8').trim();
  if (!text) throw new Error('text file is empty');
  if (text.length > MAX_CHARS) throw new Error(`text is ${text.length} characters (max ${MAX_CHARS} for say); use the read command for long texts`);

  const root = deps.root ?? getCareerOpsRoot();
  const now = deps.now ?? (() => Date.now());
  const fetchImpl = deps.fetchImpl ?? fetch;
  const cfg = loadVoiceConfig({ root });
  if (opts.persona && !(opts.persona in cfg.settings.personas)) {
    throw new Error(`unknown persona "${opts.persona}" (defined: ${Object.keys(cfg.settings.personas).join(', ') || 'none'})`);
  }
  const s = cfg.persona(opts.persona);
  const key = cacheKey(text, s.voice, s.style, s.style_degree, s.rate, s.pitch);

  let wav = s.cache ? getCached(root, key) : null;
  if (!wav) {
    let supportedStyles = [];
    if (s.style != null) {
      try {
        const voices = await listVoices({ region: cfg.azure.region, key: cfg.azure.key, cacheDir: join(root, 'output', 'voice'), now: now(), fetchImpl });
        supportedStyles = stylesForVoice(voices, s.voice);
      } catch (e) {
        stderr(`voice: could not read the style list (${e.message}); speaking without a style\n`);
      }
    }
    const { ssml, warnings } = buildSsml({ text, locale: s.locale, voice: s.voice, style: s.style, styleDegree: s.style_degree, rate: s.rate, pitch: s.pitch, supportedStyles });
    for (const w of warnings) stderr(`voice: ${w}\n`);
    const audio = await synthesize({ ssml, region: cfg.azure.region, key: cfg.azure.key, fetchImpl });
    wav = putCached(root, key, audio);

    const date = new Date(now()).toISOString().slice(0, 10);
    appendUsage({ root, date, operation: 'say', chars: text.length });
    const used = monthUsage(root, date.slice(0, 7).replace('-', ''));
    const b = budgetStatus(used, s.monthly_char_budget);
    if (b.warn90) stderr(`voice: ${used} of ${s.monthly_char_budget} monthly characters used (over 90%)\n`);
  }

  stdout(`${wav}\n`);
  if (!opts.noPlay && s.enabled) {
    await play(wav, { player: detectPlayer(deps.platform ?? process.platform, s.player), spawnImpl: deps.spawnImpl });
  }
}

// Returns the exit code; deps are injectable so tests need no network or audio.
export async function main(argv, deps = {}) {
  const stdout = deps.stdout ?? ((x) => process.stdout.write(x));
  const stderr = deps.stderr ?? ((x) => process.stderr.write(x));
  const [command, ...rest] = argv;
  try {
    if (command === 'say') {
      await say(rest, deps, { stdout, stderr });
      return 0;
    }
    if (FUTURE.includes(command)) {
      stderr(`voice: "${command}" is not implemented yet\n`);
      return 1;
    }
    stderr(`voice: unknown command "${command ?? ''}" (available: say; coming: ${FUTURE.join(', ')})\n`);
    return 1;
  } catch (e) {
    stderr(`voice: ${e.message}\n`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
