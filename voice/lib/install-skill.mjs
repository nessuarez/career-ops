// Copies voice/skill/SKILL.md to <home>/.claude/skills/interview-voice/SKILL.md.
import { mkdirSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE = join(dirname(fileURLToPath(import.meta.url)), '..', 'skill', 'SKILL.md');

// Returns the destination path. Only touches <home>/.claude/skills/interview-voice/.
export function installSkill({ home = homedir(), copy = copyFileSync, mkdir = mkdirSync } = {}) {
  const dir = join(home, '.claude', 'skills', 'interview-voice');
  mkdir(dir, { recursive: true });
  const dest = join(dir, 'SKILL.md');
  copy(SOURCE, dest);
  return dest;
}
