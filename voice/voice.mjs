// Voice CLI: node voice/voice.mjs say --text-file <path> [--persona <name>] [--no-play]
// Text always comes from a file, never from argv (job-posting content is untrusted).
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadVoiceConfig } from './lib/config.mjs';
import { detectPlayer, play } from './lib/player.mjs';
import { createSpeaker, resolvePersona } from './lib/speak.mjs';
import { doctor, voicesCmd, readCmd, recordCmd, assessCmd } from './lib/commands.mjs';
import { installSkill } from './lib/install-skill.mjs';
import { getCareerOpsRoot } from '../path-resolver.mjs';

const MAX_CHARS = 5000;
const FUTURE = ['drill', 'progress'];
const COMMANDS = { doctor, voices: voicesCmd, read: readCmd, record: recordCmd, assess: assessCmd };

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
  const cfg = loadVoiceConfig({ root });
  const s = resolvePersona(cfg, opts.persona, root);
  const speaker = createSpeaker({ root, cfg, deps, stderr });
  const { wav, cached } = await speaker.wavFor(text, s, 'say');
  if (!cached) speaker.budgetWarn(s);

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
    if (command === 'install-skill') {
      stdout(`${installSkill({ home: deps.home, copy: deps.copy })}\n`);
      return 0;
    }
    if (COMMANDS[command]) {
      const root = deps.root ?? getCareerOpsRoot();
      return await COMMANDS[command](rest, deps, { stdout, stderr, root });
    }
    if (FUTURE.includes(command)) {
      stderr(`voice: "${command}" is not implemented yet\n`);
      return 1;
    }
    stderr(`voice: unknown command "${command ?? ''}" (available: say, install-skill,${Object.keys(COMMANDS).join(', ')}; coming: ${FUTURE.join(', ')})\n`);
    return 1;
  } catch (e) {
    stderr(`voice: ${e.message}\n`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
