// WAV header facts and ffmpeg conversion of phone recordings (m4a, mp3, ...) to the format Azure Speech reads.
// ffmpeg is spawned with an argument array, never through a shell, so a file name cannot inject anything.
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';

export const FFMPEG_HINT = 'ffmpeg not found on PATH; install it (winget install Gyan.FFmpeg) and restart the shell';

// Facts from the RIFF header; null when the buffer is not a WAV (then it needs converting).
// Duration is data size / byte rate, with the data size clipped to what the buffer holds,
// because streamed WAVs often carry a bogus size.
export function parseWavHeader(b) {
  if (b.length < 12 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') return null;
  let fmt = null;
  for (let p = 12; p + 8 <= b.length;) {
    const id = b.toString('ascii', p, p + 4);
    const size = b.readUInt32LE(p + 4);
    if (id === 'fmt ' && p + 24 <= b.length) {
      fmt = { format: b.readUInt16LE(p + 8), channels: b.readUInt16LE(p + 10), rate: b.readUInt32LE(p + 12), byteRate: b.readUInt32LE(p + 16), bits: b.readUInt16LE(p + 22) };
    } else if (id === 'data') {
      if (!fmt || !fmt.byteRate) return null;
      const dataBytes = Math.min(size, b.length - (p + 8));
      const { byteRate, ...rest } = fmt;
      return { ...rest, durationS: dataBytes / byteRate };
    }
    p += 8 + size + (size % 2);
  }
  return null;
}

// Azure takes 16 kHz mono 16-bit PCM directly; anything else is converted first.
export const isSpeechReadyWav = (h) => !!h && h.format === 1 && h.channels === 1 && h.rate === 16000 && h.bits === 16;

export const buildFfmpegArgs = (input, out) => ['-y', '-hide_banner', '-loglevel', 'error', '-i', input, '-ac', '1', '-ar', '16000', '-sample_fmt', 's16', out];

export function convertToWav({ input, out, spawnImpl = spawn }) {
  return new Promise((resolve, reject) => {
    const fail = (message) => {
      rmSync(out, { force: true });
      reject(new Error(message));
    };
    let child;
    try {
      child = spawnImpl('ffmpeg', buildFfmpegArgs(input, out), { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
      return fail(e.code === 'ENOENT' ? FFMPEG_HINT : `could not start ffmpeg: ${e.message}`);
    }
    let stderr = '';
    child.stderr?.on('data', (d) => { stderr += d; });
    child.on('error', (e) => fail(e.code === 'ENOENT' ? FFMPEG_HINT : `could not start ffmpeg: ${e.message}`));
    child.on('close', (code) => {
      if (code === 0) return resolve(out);
      const tail = stderr.trim().split(/\r?\n/).pop();
      fail(`ffmpeg failed (exit ${code})${tail ? `: ${tail}` : ''}`);
    });
  });
}

// For doctor: is ffmpeg on PATH?
export function checkFfmpeg({ spawnImpl = spawn } = {}) {
  return new Promise((resolve) => {
    const missing = () => resolve({ ok: false, message: FFMPEG_HINT });
    let child;
    try {
      child = spawnImpl('ffmpeg', ['-version'], { stdio: ['ignore', 'ignore', 'ignore'] });
    } catch {
      return missing();
    }
    child.on('error', missing);
    child.on('close', (code) => (code === 0 ? resolve({ ok: true }) : missing()));
  });
}
