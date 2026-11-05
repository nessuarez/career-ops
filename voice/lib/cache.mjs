// WAV cache keyed by everything that changes the audio: <root>/output/voice/cache/<hash>.wav
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function cacheKey(text, voice, style, degree, rate, pitch) {
  // JSON keeps field boundaries unambiguous ("a"+"bc" differs from "ab"+"c").
  return createHash('sha256').update(JSON.stringify([text, voice, style ?? null, degree, rate, pitch])).digest('hex');
}

const cacheDir = (root) => join(root, 'output', 'voice', 'cache');

export function getCached(root, key) {
  const file = join(cacheDir(root), `${key}.wav`);
  return existsSync(file) ? file : null;
}

export function putCached(root, key, wavBuffer) {
  mkdirSync(cacheDir(root), { recursive: true });
  const file = join(cacheDir(root), `${key}.wav`);
  writeFileSync(file, wavBuffer);
  return file;
}
