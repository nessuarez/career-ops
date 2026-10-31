// Records the microphone with SoX and reads WAV facts (duration, peak). SoX is spawned
// with an argument array, never through a shell, so the device name cannot inject anything.
import { spawn } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';

const DRIVERS = { win32: 'waveaudio', darwin: 'coreaudio', linux: 'alsa' };

const INSTALL_HINT = 'install it with "winget install ChrisBagwell.SoX" and restart the shell so PATH picks it up';
const MIC_HINT = 'check the microphone permission (Settings > Privacy & security > Microphone) and the record_device setting';

// Sound needed to start recording: at 0.1 s a 0.19 s noise (likely the Enter key) started it,
// and the silence before the speech then ended it.
const START_SOUND_S = '0.3';

// Speech starts the recording; `stop_silence_s` of quiet ends it; `max` is only a safety net
// (a fixed cut once truncated a real reading and produced false omissions). `trim` goes before
// `silence` so it caps the time spent listening: after `silence` it never ends if nothing is heard.
export function buildSoxArgs({ settings, out, max, platform = process.platform, untilSilence = true }) {
  const th = settings.record_silence_threshold;
  return [
    '-q', '-t', DRIVERS[platform] ?? 'waveaudio', settings.record_device,
    '-r', '16000', '-c', '1', '-b', '16', out,
    'trim', '0', String(max),
    ...(untilSilence ? ['silence', '1', START_SOUND_S, th, '1', String(settings.record_stop_silence_s), th] : []),
  ];
}

export function wavInfo(file) {
  const b = readFileSync(file);
  if (b.length < 12 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${file} is not a valid WAV`);
  }
  let rate = 0;
  let channels = 1;
  for (let p = 12; p + 8 <= b.length;) {
    const id = b.toString('ascii', p, p + 4);
    const size = b.readUInt32LE(p + 4);
    if (id === 'fmt ') {
      channels = b.readUInt16LE(p + 10);
      rate = b.readUInt32LE(p + 12);
    } else if (id === 'data') {
      const end = Math.min(b.length, p + 8 + size);
      let peak = 0;
      for (let i = p + 8; i + 2 <= end; i += 2) peak = Math.max(peak, Math.abs(b.readInt16LE(i)));
      return { durationS: rate ? (end - p - 8) / 2 / channels / rate : 0, peak: peak / 32768 };
    }
    p += 8 + size + (size % 2);
  }
  throw new Error(`${file} is not a valid WAV (no data chunk)`);
}

export function record({ settings, out, max, spawnImpl = spawn, platform = process.platform, untilSilence = true }) {
  return new Promise((resolve, reject) => {
    const fail = (message, code) => reject(Object.assign(new Error(message), code ? { code } : {}));
    // Only once sox has run: if it never started, a file at `out` is an earlier recording.
    const discard = (message) => {
      rmSync(out, { force: true });
      fail(message);
    };
    let child;
    let stderr = '';
    const missing = () => fail(`sox was not found on PATH: ${INSTALL_HINT}`, 'SOX_MISSING');
    try {
      child = spawnImpl('sox', buildSoxArgs({ settings, out, max, platform, untilSilence }), { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
      return e.code === 'ENOENT' ? missing() : fail(`could not start sox: ${e.message}`);
    }
    child.stderr?.on('data', (d) => { stderr += d; });
    child.on('error', (e) => (e.code === 'ENOENT' ? missing() : fail(`could not start sox: ${e.message}`)));
    child.on('close', (code) => {
      if (code !== 0) {
        const tail = stderr.trim().split(/\r?\n/).pop();
        return discard(`sox exited with code ${code}${tail ? ` (${tail})` : ''}: ${MIC_HINT}`);
      }
      let info;
      try {
        info = wavInfo(out);
      } catch (e) {
        return discard(`${e.message}: ${MIC_HINT}`);
      }
      if (info.durationS === 0) {
        return discard(`no speech detected in ${max} s: ${MIC_HINT}, or lower record_silence_threshold`);
      }
      resolve({ path: out, ...info });
    });
  });
}
