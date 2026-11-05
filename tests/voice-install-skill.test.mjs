import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installSkill } from '../voice/lib/install-skill.mjs';
import { main } from '../voice/voice.mjs';

const SKILL = join(dirname(fileURLToPath(import.meta.url)), '..', 'voice', 'skill', 'SKILL.md');
const tmp = () => mkdtempSync(join(tmpdir(), 'voice-skill-'));

test('installs SKILL.md under <home>/.claude/skills/interview-voice', () => {
  const home = tmp();
  try {
    const dest = installSkill({ home });
    assert.equal(dest, join(home, '.claude', 'skills', 'interview-voice', 'SKILL.md'));
    assert.equal(readFileSync(dest, 'utf8'), readFileSync(SKILL, 'utf8'));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('overwrites an existing file', () => {
  const home = tmp();
  try {
    const dir = join(home, '.claude', 'skills', 'interview-voice');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), 'old');
    installSkill({ home });
    assert.notEqual(readFileSync(join(dir, 'SKILL.md'), 'utf8'), 'old');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('writes nothing outside the skill folder', () => {
  const home = tmp();
  try {
    installSkill({ home });
    assert.deepEqual(readdirSync(home), ['.claude']);
    assert.deepEqual(readdirSync(join(home, '.claude')), ['skills']);
    assert.deepEqual(readdirSync(join(home, '.claude', 'skills')), ['interview-voice']);
    assert.deepEqual(readdirSync(join(home, '.claude', 'skills', 'interview-voice')), ['SKILL.md']);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('install-skill command prints the destination path', async () => {
  const home = tmp();
  let out = '';
  try {
    const code = await main(['install-skill'], { home, stdout: (x) => { out += x; }, stderr: () => {} });
    assert.equal(code, 0);
    assert.ok(out.includes(join(home, '.claude', 'skills', 'interview-voice', 'SKILL.md')));
    assert.ok(existsSync(join(home, '.claude', 'skills', 'interview-voice', 'SKILL.md')));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('SKILL.md has frontmatter and mentions the commands, never a key', () => {
  const t = readFileSync(SKILL, 'utf8');
  assert.match(t, /^---\nname: interview-voice\n/);
  assert.match(t, /\ndescription: .+/);
  for (const w of ['say', 'read', 'doctor', 'voices']) assert.ok(t.includes(w), w);
  assert.ok(!/AZURE_SPEECH_KEY\s*=/.test(t));
  assert.ok(!/[0-9a-f]{32}/i.test(t));
});
