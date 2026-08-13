#!/usr/bin/env node

/**
 * manual-login.mjs — one-time manual login into the MCP Playwright browser's
 * persistent Chrome profile, viewable from any device with a web browser via
 * VNC-over-websockets (Xvfb + x11vnc + websockify + noVNC). No X server or
 * GUI is required anywhere in the SSH chain.
 *
 * Purely a human-in-the-loop utility: it opens ONE URL and waits for you to
 * log in yourself in the browser tab. It is never invoked by scan.mjs,
 * browser-extract.mjs, check-liveness.mjs, or any automated/batch flow — see
 * "ToS-grey / authenticated integrations" in docs/PLUGIN_REVIEW.md for why
 * authenticated scraping stays out of the automated core regardless of site.
 *
 * Usage:
 *   node manual-login.mjs <url> [--port 6080] [--display 99] [--profile <dir>]
 *   node manual-login.mjs --status
 *   node manual-login.mjs --stop
 */

import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'fs';
import { execSync, spawn } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';

const argv = process.argv.slice(2);
const STATE_FILE = join(homedir(), '.cache', 'career-ops-manual-login-state.json');
const MCP_PROFILE_ROOT = join(homedir(), '.cache', 'ms-playwright-mcp');
const PLAYWRIGHT_ROOT = join(homedir(), '.cache', 'ms-playwright');

function flag(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
}

function commandExists(cmd) {
  try {
    execSync(`which ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function loadState() {
  if (!existsSync(STATE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function findChromiumBinary() {
  if (!existsSync(PLAYWRIGHT_ROOT)) return null;
  const dirs = readdirSync(PLAYWRIGHT_ROOT).filter((d) => d.startsWith('chromium-') && !d.includes('headless_shell'));
  dirs.sort().reverse();
  for (const d of dirs) {
    const bin = join(PLAYWRIGHT_ROOT, d, 'chrome-linux64', 'chrome');
    if (existsSync(bin)) return bin;
  }
  return null;
}

function findProfileDirs() {
  if (!existsSync(MCP_PROFILE_ROOT)) return [];
  return readdirSync(MCP_PROFILE_ROOT).filter((d) => d.startsWith('mcp-chrome-'));
}

function clearStaleLock(profileDir) {
  const lock = join(profileDir, 'SingletonLock');
  if (!existsSync(lock)) return;
  try {
    const target = readlinkSync(lock); // "<hostname>-<pid>"
    const pid = Number(target.split('-').pop());
    if (pid && pidAlive(pid)) {
      throw new Error(
        `Profile is locked by a live process (pid ${pid}) — another Chrome instance ` +
        `(possibly the MCP server itself) is using this profile right now. Close it first.`
      );
    }
  } catch (e) {
    if (e.message.includes('locked by a live process')) throw e;
    // unreadable symlink — treat as stale
  }
  for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    rmSync(join(profileDir, f), { force: true });
  }
}

function status() {
  const state = loadState();
  if (!state) {
    console.log('No manual-login session recorded.');
    return;
  }
  console.log(`Session started: ${state.startedAt}`);
  console.log(`URL: ${state.url}`);
  console.log(`Profile: ${state.profileDir}`);
  console.log(`Display: :${state.display}  VNC: 5900 (localhost)  websocket: ${state.wsPort} (localhost)`);
  for (const [name, pid] of Object.entries(state.pids)) {
    console.log(`  ${name} (pid ${pid}): ${pidAlive(pid) ? 'running' : 'dead'}`);
  }
  if (Object.values(state.pids).every(pidAlive)) {
    console.log(`\nTunnel command (run on the device with a browser):`);
    console.log(`  ssh -L ${state.wsPort}:localhost:${state.wsPort} <user>@<this-host>`);
    console.log(`Then open: http://localhost:${state.wsPort}/vnc.html`);
  }
}

function stop() {
  const state = loadState();
  if (!state) {
    console.log('No manual-login session recorded — nothing to stop.');
    return;
  }
  for (const [name, pid] of Object.entries(state.pids)) {
    if (pidAlive(pid)) {
      try {
        process.kill(pid, 'SIGTERM');
        console.log(`Stopped ${name} (pid ${pid}).`);
      } catch (e) {
        console.log(`Could not stop ${name} (pid ${pid}): ${e.message}`);
      }
    }
  }
  const forceCleanup = () => {
    for (const pid of Object.values(state.pids)) {
      if (pidAlive(pid)) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
      }
    }
    // We own every pid in state.pids (we started them), so once they're dead
    // the lock is ours to clear unconditionally — skip clearStaleLock's
    // liveness re-check, which exists to protect start() from an unrelated
    // active session, not to gate our own teardown.
    for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
      rmSync(join(state.profileDir, f), { force: true });
    }
    rmSync(STATE_FILE, { force: true });
    console.log('Session stopped and cleaned up. The login persists in the profile for the MCP browser to reuse.');
  };

  setTimeout(() => {
    if (Object.values(state.pids).some(pidAlive)) {
      setTimeout(forceCleanup, 1500); // give SIGTERM stragglers one more beat before SIGKILL
    } else {
      forceCleanup();
    }
  }, 1500);
}

function start(url) {
  const existing = loadState();
  if (existing && Object.values(existing.pids).some(pidAlive)) {
    console.error('A manual-login session is already running. Run `node manual-login.mjs --status` or `--stop` first.');
    process.exit(1);
  }

  for (const cmd of ['Xvfb', 'x11vnc', 'websockify']) {
    if (!commandExists(cmd)) {
      console.error(`Missing dependency: ${cmd}`);
      console.error('Install with: sudo apt update && sudo apt install -y x11vnc novnc websockify');
      process.exit(1);
    }
  }

  const chromiumBin = findChromiumBinary();
  if (!chromiumBin) {
    console.error(`No Playwright-managed Chromium found under ${PLAYWRIGHT_ROOT}. Run the MCP browser at least once (or \`npx playwright install chromium\`) first.`);
    process.exit(1);
  }

  let profileName = flag('profile', null);
  const profiles = findProfileDirs();
  if (!profileName) {
    if (profiles.length === 0) {
      console.error(
        `No persistent MCP Chrome profile found under ${MCP_PROFILE_ROOT}. ` +
        `Make sure .mcp.json's playwright entry does NOT pass --isolated, and that the MCP browser has run at least once.`
      );
      process.exit(1);
    }
    if (profiles.length > 1) {
      console.error(`Multiple profiles found, pick one with --profile:\n  ${profiles.join('\n  ')}`);
      process.exit(1);
    }
    profileName = profiles[0];
  }
  const profileDir = join(MCP_PROFILE_ROOT, profileName);

  try {
    clearStaleLock(profileDir);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  const display = flag('display', '99');
  const wsPort = flag('port', '6080');

  console.log(`Starting virtual display :${display} ...`);
  const xvfb = spawn('Xvfb', [`:${display}`, '-screen', '0', '1280x800x24'], { detached: true, stdio: 'ignore' });
  xvfb.unref();

  console.log('Starting VNC server (bound to 127.0.0.1 only) ...');
  const x11vnc = spawn('x11vnc', ['-display', `:${display}`, '-localhost', '-nopw', '-forever', '-shared'], { detached: true, stdio: 'ignore' });
  x11vnc.unref();

  console.log(`Starting websocket bridge on 127.0.0.1:${wsPort} ...`);
  const websockify = spawn('websockify', ['--web=/usr/share/novnc/', `127.0.0.1:${wsPort}`, 'localhost:5900'], { detached: true, stdio: 'ignore' });
  websockify.unref();

  console.log(`Opening ${url} in the persistent profile ...`);
  const chrome = spawn(chromiumBin, [
    `--user-data-dir=${profileDir}`,
    '--no-sandbox',
    '--window-size=1280,800',
    url,
  ], { detached: true, stdio: 'ignore', env: { ...process.env, DISPLAY: `:${display}` } });
  chrome.unref();

  const state = {
    startedAt: new Date().toISOString(),
    url,
    profileDir,
    display,
    wsPort,
    pids: { xvfb: xvfb.pid, x11vnc: x11vnc.pid, websockify: websockify.pid, chrome: chrome.pid },
  };
  saveState(state);

  setTimeout(() => {
    console.log(`\nReady. On the device with a browser, run:`);
    console.log(`  ssh -L ${wsPort}:localhost:${wsPort} <your-user>@<this-host>`);
    console.log(`Then open: http://localhost:${wsPort}/vnc.html  (Connect, no password)`);
    console.log(`\nLog in as yourself in that window. When done:`);
    console.log(`  node manual-login.mjs --stop`);
  }, 1500);
}

if (argv.includes('--status')) {
  status();
} else if (argv.includes('--stop')) {
  stop();
} else {
  const url = argv.find((a) => !a.startsWith('--'));
  if (!url) {
    console.error('Usage: node manual-login.mjs <url> [--port 6080] [--display 99] [--profile <dir>]');
    console.error('       node manual-login.mjs --status');
    console.error('       node manual-login.mjs --stop');
    process.exit(1);
  }
  start(url);
}
