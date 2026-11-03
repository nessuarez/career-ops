// Records the microphone with SoX and reads WAV facts (duration, peak). SoX is spawned
// with an argument array, never through a shell, so the device name cannot inject anything.
import { spawn } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';

const DRIVERS = { win32: 'waveaudio', darwin: 'coreaudio', linux: 'alsa' };

const INSTALL_HINT = 'install it with "winget install ChrisBagwell.SoX" and restart the shell so PATH picks it up';
const MIC_HINT = 'check the microphone permission (Settings > Privacy & security > Microphone) and the record_device setting';

// Speech detection runs in Node on the raw PCM that SoX streams to stdout. The SoX `silence`
// effect was dropped: one short noise started its "speech" and the pause before the real speech
// then ended the recording, while a quiet voice stayed under its fixed threshold.
const RATE = 16000;
const WINDOW_S = 0.05;
const CALIBRATION_S = 0.5; // room noise is measured over the start of the recording
const NOISE_FACTOR = 4;
const MAX_THRESHOLD = 0.01; // 1% RMS: the calibrated threshold never goes above this
export const MIN_SPEECH_S = 1.0; // silence cannot end a recording before this much speech was heard
const KEEP_SILENCE_S = 0.5; // trailing silence kept after the last speech window

const parsePercent = (v) => parseFloat(v) / 100;

// Pure speech detector over 16-bit samples, in 50 ms RMS windows (normalized to 0..1).
// Threshold rule: during the first 0.5 s only the room noise is measured (the maximum window RMS);
// then threshold = max(minThreshold, min(noise x 4, 1%)). A quiet room uses the configured
// minimum, a noisy room raises it, and the calibrated value is capped at 1% (a minimum above
// that still wins). A window with RMS >= threshold is speech. A run of `stopSilenceS` of silent
// windows ends the recording only once MIN_SPEECH_S of speech has accumulated, so a stray noise
// before the real speech never ends it.
export function createSpeechDetector({ rate = RATE, minThreshold, stopSilenceS, windowS = WINDOW_S }) {
  const win = Math.round(rate * windowS);
  const calibWindows = Math.round(CALIBRATION_S / windowS);
  const stopWindows = Math.ceil(stopSilenceS / windowS - 1e-9);
  let pending = new Int16Array(0);
  let total = 0;
  let windows = 0;
  let noise = 0;
  let threshold = null;
  let speechWindows = 0;
  let silentRun = 0;
  let lastSpeechEnd = null;
  let stopped = false;

  const onWindow = (w) => {
    let sum = 0;
    for (let i = 0; i < w.length; i++) sum += w[i] * w[i];
    const rms = Math.sqrt(sum / w.length) / 32768;
    windows++;
    if (threshold === null) {
      noise = Math.max(noise, rms);
      if (windows >= calibWindows) threshold = Math.max(minThreshold, Math.min(noise * NOISE_FACTOR, MAX_THRESHOLD));
      return;
    }
    if (rms >= threshold) {
      speechWindows++;
      silentRun = 0;
      lastSpeechEnd = windows * win;
    } else {
      silentRun++;
      if (silentRun >= stopWindows && speechWindows * windowS >= MIN_SPEECH_S - 1e-9) stopped = true;
    }
  };

  return {
    // Feeds samples; returns true once the recording should stop.
    push(int16) {
      total += int16.length;
      let data = int16;
      if (pending.length) {
        data = new Int16Array(pending.length + int16.length);
        data.set(pending);
        data.set(int16, pending.length);
      }
      let p = 0;
      for (; !stopped && p + win <= data.length; p += win) onWindow(data.subarray(p, p + win));
      pending = data.slice(p);
      return stopped;
    },
    threshold: () => threshold ?? minThreshold,
    speechSeconds: () => speechWindows * windowS,
    // Samples to keep: through the last speech window plus at most 0.5 s of silence.
    trimSamples: () => (lastSpeechEnd === null ? total : Math.min(total, lastSpeechEnd + Math.round(KEEP_SILENCE_S * rate))),
  };
}

// Raw signed 16-bit PCM goes to stdout; `trim 0 max` makes sox exit by itself at max.
export function buildSoxArgs({ settings, max, platform = process.platform }) {
  return [
    '-q', '-t', DRIVERS[platform] ?? 'waveaudio', settings.record_device,
    '-r', String(RATE), '-c', '1', '-b', '16', '-e', 'signed-integer', '-t', 'raw', '-',
    'trim', '0', String(max),
  ];
}

function writeWav(file, pcm, rate = RATE) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVEfmt ', 8, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(pcm.length, 40);
  writeFileSync(file, Buffer.concat([h, pcm]));
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
    const detector = untilSilence
      ? createSpeechDetector({ minThreshold: parsePercent(settings.record_silence_threshold), stopSilenceS: settings.record_stop_silence_s })
      : null;
    try {
      child = spawnImpl('sox', buildSoxArgs({ settings, max, platform }), { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return e.code === 'ENOENT' ? missing() : fail(`could not start sox: ${e.message}`);
    }
    const chunks = [];
    let odd = null; // a trailing byte split across two chunks
    let stopped = false;
    child.stdout?.on('data', (d) => {
      if (stopped) return;
      let buf = odd ? Buffer.concat([odd, d]) : d;
      odd = buf.length % 2 ? Buffer.from(buf.subarray(buf.length - 1)) : null;
      if (odd) buf = buf.subarray(0, buf.length - 1);
      if (!buf.length) return;
      const copy = Buffer.from(buf); // own, 2-aligned memory for the Int16Array view
      chunks.push(copy);
      if (detector?.push(new Int16Array(copy.buffer, copy.byteOffset, copy.length / 2))) {
        stopped = true;
        child.kill();
      }
    });
    child.stderr?.on('data', (d) => { stderr += d; });
    child.on('error', (e) => (e.code === 'ENOENT' ? missing() : fail(`could not start sox: ${e.message}`)));
    child.on('close', (code) => {
      // Our own kill on stop is not a sox failure.
      if (code !== 0 && !stopped) {
        const tail = stderr.trim().split(/\r?\n/).pop();
        return discard(`sox exited with code ${code}${tail ? ` (${tail})` : ''}: ${MIC_HINT}`);
      }
      let pcm = Buffer.concat(chunks);
      if (detector) {
        if (detector.speechSeconds() < MIN_SPEECH_S - 1e-9) {
          return discard(`no speech detected in ${max} s: ${MIC_HINT}, or lower record_silence_threshold`);
        }
        pcm = pcm.subarray(0, Math.min(pcm.length, detector.trimSamples() * 2));
      }
      if (!pcm.length) return discard(`sox produced no audio: ${MIC_HINT}`);
      try {
        writeWav(out, pcm);
        resolve({ path: out, ...wavInfo(out) });
      } catch (e) {
        discard(`${e.message}: ${MIC_HINT}`);
      }
    });
  });
}
