// Picks a WAV player per platform and runs it. The wav path never becomes part of a
// command string that a shell or PowerShell parses.
import { spawn, spawnSync } from 'node:child_process';

// On Windows the path travels in an environment variable that the script reads as
// $env:CAREER_OPS_VOICE_WAV. Nothing from the path is interpolated into the PowerShell
// command text, so quotes, spaces, `;` or `$()` in a path cannot change what runs
// (argument concatenation by -Command would otherwise re-parse it).
const WIN_ENV = 'CAREER_OPS_VOICE_WAV';
const WIN_SCRIPT = `(New-Object Media.SoundPlayer $env:${WIN_ENV}).PlaySync()`;

const PLAYERS = {
  powershell: { cmd: 'powershell.exe', args: () => ['-NoProfile', '-Command', WIN_SCRIPT], env: (wav) => ({ [WIN_ENV]: wav }) },
  afplay: { cmd: 'afplay', args: (wav) => [wav] },
  aplay: { cmd: 'aplay', args: (wav) => [wav] },
  paplay: { cmd: 'paplay', args: (wav) => [wav] },
  ffplay: { cmd: 'ffplay', args: (wav) => ['-nodisp', '-autoexit', wav] },
};

const onPath = (cmd) => spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' }).status === 0;

export function detectPlayer(platform, preference = 'auto', { has = onPath } = {}) {
  if (preference && preference !== 'auto') {
    const p = PLAYERS[preference];
    if (!p) throw new Error(`unknown player "${preference}"`);
    return p;
  }
  if (platform === 'win32') return PLAYERS.powershell;
  if (platform === 'darwin') return PLAYERS.afplay;
  return PLAYERS[['aplay', 'paplay', 'ffplay'].find((c) => has(c)) ?? 'aplay'];
}

export function play(wavPath, { player, spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const env = player.env ? { ...process.env, ...player.env(wavPath) } : process.env;
    let child;
    try {
      child = spawnImpl(player.cmd, player.args(wavPath), { stdio: 'ignore', env });
    } catch (e) {
      reject(new Error(`could not start player ${player.cmd}: ${e.message}`));
      return;
    }
    child.on('error', (e) => reject(new Error(`could not start player ${player.cmd}: ${e.message}`)));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`player ${player.cmd} exited with code ${code}`))));
  });
}
