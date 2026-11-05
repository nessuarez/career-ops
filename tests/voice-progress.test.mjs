import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../voice/voice.mjs';
import { parseSince, loadAssessments, summarizeProgress } from '../voice/lib/progress.mjs';

const NOW = Date.parse('2026-11-05T12:00:00Z');

const sess = (mode, p, a, f, pr, wpm, words = []) => ({
  mode,
  scores: { pronunciation: p, accuracy: a, fluency: f, prosody: pr },
  timing: { wpm },
  words_to_fix: words.map(([word, ph]) => ({ word, accuracy: 40, worst_phonemes: [{ phoneme: ph, accuracy: 20 }] })),
});

function withDir(files, fn) {
  const root = mkdtempSync(join(tmpdir(), 'voice-progress-'));
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  try {
    const dir = join(root, 'output', 'voice', 'assessments');
    mkdirSync(dir, { recursive: true });
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));
    const result = fn(root);
    if (result && typeof result.then === 'function') return result.finally(cleanup);
    cleanup();
    return result;
  } catch (e) {
    cleanup();
    throw e;
  }
}

test('parseSince: date, Nd, default and invalid', () => {
  assert.equal(parseSince('2026-10-01', NOW), '2026-10-01');
  assert.equal(parseSince('7d', NOW), '2026-10-29');
  assert.equal(parseSince(undefined, NOW), '2026-10-06');
  assert.equal(parseSince('0d', NOW), '2026-11-05');
  for (const bad of ['abc', '2026-13-01', '2026-02-30', '-3d', '7', '7days', '']) assert.throws(() => parseSince(bad, NOW), /--since/, bad);
});

test('loadAssessments filters by filename date, orders chronologically, skips bad files with a warning', () => {
  const warns = [];
  withDir(
    {
      '2026-11-03-b.json': sess('free', 70, 70, 70, 70, 130),
      '2026-11-03-a.json': sess('scripted', 60, 60, 60, 60, 120),
      '2026-10-01-old.json': sess('free', 1, 1, 1, 1, 1),
      '2026-11-04-bad.json': '{not json',
      'notes.json': sess('free', 1, 1, 1, 1, 1),
    },
    (root) => {
      const list = loadAssessments(root, '2026-10-20', { warn: (m) => warns.push(m) });
      assert.deepEqual(list.map((s) => s.file), ['2026-11-03-a.json', '2026-11-03-b.json']);
      assert.deepEqual(list.map((s) => s.date), ['2026-11-03', '2026-11-03']);
      assert.equal(warns.length, 2);
      assert.ok(warns.some((w) => w.includes('2026-11-04-bad.json')));
      assert.ok(warns.some((w) => w.includes('notes.json')));
    },
  );
});

test('loadAssessments: a missing directory is an empty list', () => {
  const root = mkdtempSync(join(tmpdir(), 'voice-progress-'));
  try {
    assert.deepEqual(loadAssessments(root, '2000-01-01'), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('summarizeProgress: averages, first-vs-last change only with 2+ sessions', () => {
  const list = [
    { date: '2026-11-01', file: 'a.json', summary: sess('scripted', 60, 50, 70, 65, 120) },
    { date: '2026-11-02', file: 'b.json', summary: sess('scripted', 70, 60, 80, 75, 140) },
    { date: '2026-11-03', file: 'c.json', summary: sess('free', 80, 70, 90, 85, 160) },
  ];
  const p = summarizeProgress(list);
  assert.equal(p.sessions.length, 3);
  assert.deepEqual(p.sessions[0], { date: '2026-11-01', file: 'a.json', mode: 'scripted', pronunciation: 60, accuracy: 50, fluency: 70, prosody: 65, wpm: 120 });
  assert.equal(p.metrics.pronunciation.avg, 70);
  assert.equal(p.metrics.pronunciation.change, 20);
  assert.equal(p.metrics.wpm.avg, 140);
  const one = summarizeProgress([list[0]]);
  assert.equal(one.metrics.accuracy.avg, 50);
  assert.equal(one.metrics.accuracy.change, null);
});

test('summarizeProgress: a metric missing in some sessions averages only those that have it', () => {
  const noWpm = sess('free', 60, 60, 60, 60, undefined);
  noWpm.timing = {};
  const p = summarizeProgress([
    { date: '2026-11-01', file: 'a.json', summary: noWpm },
    { date: '2026-11-02', file: 'b.json', summary: sess('free', 70, 70, 70, 70, 130) },
  ]);
  assert.equal(p.metrics.wpm.avg, 130);
  assert.equal(p.metrics.wpm.change, null);
  assert.equal(p.metrics.pronunciation.change, 10);
});

test('summarizeProgress: repeated words and worst phonemes, case-insensitive, 2+ sessions, sorted', () => {
  const p = summarizeProgress([
    { date: '2026-11-01', file: 'a.json', summary: sess('free', 1, 1, 1, 1, 1, [['Changes', 'tʃ'], ['think', 'θ'], ['think', 'θ']]) },
    { date: '2026-11-02', file: 'b.json', summary: sess('free', 1, 1, 1, 1, 1, [['changes', 'tʃ'], ['think', 'θ'], ['rare', 'r']]) },
    { date: '2026-11-03', file: 'c.json', summary: sess('free', 1, 1, 1, 1, 1, [['think', 'ð'], ['zeta', 'z']]) },
  ]);
  assert.deepEqual(p.repeatedWords, [{ word: 'think', count: 3 }, { word: 'changes', count: 2 }]);
  assert.deepEqual(p.repeatedPhonemes, [{ phoneme: 'tʃ', count: 2 }, { phoneme: 'θ', count: 2 }]);
});

function cli(args, files) {
  return withDir(files, async (root) => {
    const out = [];
    const err = [];
    const code = await main(args, { root, now: () => NOW, stdout: (s) => out.push(s), stderr: (s) => err.push(s) });
    return { code, out: out.join(''), err: err.join('') };
  });
}

test('progress prints a line per session, averages and repeats', async () => {
  const r = await cli(['progress', '--since', '2026-11-01'], {
    '2026-11-01-a.json': sess('scripted', 60, 50, 70, 65, 120, [['think', 'θ']]),
    '2026-11-02-b.json': sess('free', 70, 60, 80, 75, 140, [['think', 'θ']]),
  });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /2026-11-01.*scripted.*60.*50.*70.*65.*120/);
  assert.match(r.out, /2026-11-02.*free/);
  assert.match(r.out, /average/i);
  assert.match(r.out, /think/);
});

test('progress --json prints the structured result', async () => {
  const r = await cli(['progress', '--json'], { '2026-11-01-a.json': sess('free', 60, 50, 70, 65, 120) });
  assert.equal(r.code, 0, r.err);
  const j = JSON.parse(r.out);
  assert.equal(j.sessions.length, 1);
  assert.equal(j.metrics.pronunciation.avg, 60);
});

test('progress with no sessions says so and exits 0', async () => {
  const r = await cli(['progress', '--since', '2000-01-01'], {});
  assert.equal(r.code, 0);
  assert.match(r.out, /no sessions/i);
  const j = await cli(['progress', '--json'], {});
  assert.deepEqual(JSON.parse(j.out).sessions, []);
});

test('progress: an invalid --since is an error', async () => {
  const r = await cli(['progress', '--since', 'soon'], {});
  assert.equal(r.code, 1);
  assert.match(r.err, /--since/);
});
