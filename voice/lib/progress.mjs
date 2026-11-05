// Progress over saved assessment summaries (output/voice/assessments/*.json). Pure functions plus one directory read.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAYS_RE = /^(\d+)d$/;
const METRICS = ['pronunciation', 'accuracy', 'fluency', 'prosody', 'wpm'];
const round1 = (n) => Math.round(n * 10) / 10;

// Returns the first included day as YYYY-MM-DD (UTC). Accepts YYYY-MM-DD or Nd; default 30d.
export function parseSince(value = '30d', now = Date.now()) {
  const bad = () => new Error(`--since must be a date like 2026-10-01 or a number of days like 30d, got "${value}"`);
  const d = String(value).match(DAYS_RE);
  if (d) return new Date(now - Number(d[1]) * 86400000).toISOString().slice(0, 10);
  const m = String(value).match(DATE_RE);
  if (!m) throw bad();
  const t = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== value) throw bad();
  return value;
}

// Sessions on or after `since`, oldest first. Files without a date prefix or with invalid JSON are skipped with a warning.
export function loadAssessments(root, since, { warn = () => {} } = {}) {
  const dir = join(root, 'output', 'voice', 'assessments');
  if (!existsSync(dir)) return [];
  const list = [];
  for (const file of readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.json'))) {
    const date = file.slice(0, 10);
    if (!DATE_RE.test(date)) {
      warn(`skipping ${file}: the name does not start with YYYY-MM-DD`);
      continue;
    }
    if (date < since) continue;
    try {
      const summary = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      if (summary === null || typeof summary !== 'object') throw new Error('not an object');
      list.push({ date, file, summary });
    } catch (e) {
      warn(`skipping ${file}: ${e.message}`);
    }
  }
  return list.sort((a, b) => a.date.localeCompare(b.date) || a.file.localeCompare(b.file));
}

const metricOf = (s, name) => {
  const v = name === 'wpm' ? s.timing?.wpm : s.scores?.[name];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
};

// Items counted once per session, case-insensitive; kept when seen in 2+ sessions. Count desc, then name.
function repeated(perSession, key) {
  const counts = new Map();
  for (const items of perSession) for (const it of new Set(items.map((x) => x.toLowerCase()))) counts.set(it, (counts.get(it) ?? 0) + 1);
  return [...counts].filter(([, c]) => c >= 2).map(([name, count]) => ({ [key]: name, count })).sort((a, b) => b.count - a.count || (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0));
}

export function summarizeProgress(list) {
  const sessions = list.map(({ date, file, summary }) => ({
    date,
    file,
    mode: summary.mode ?? null,
    ...Object.fromEntries(METRICS.map((m) => [m, metricOf(summary, m)])),
  }));
  const metrics = {};
  for (const m of METRICS) {
    const vals = sessions.map((s) => s[m]).filter((v) => v !== null);
    metrics[m] = {
      n: vals.length,
      avg: vals.length ? round1(vals.reduce((a, b) => a + b, 0) / vals.length) : null,
      change: vals.length >= 2 ? round1(vals[vals.length - 1] - vals[0]) : null,
    };
  }
  const fixes = list.map(({ summary }) => summary.words_to_fix ?? []);
  return {
    sessions,
    metrics,
    repeatedWords: repeated(fixes.map((f) => f.map((w) => w.word).filter(Boolean)), 'word'),
    repeatedPhonemes: repeated(fixes.map((f) => f.map((w) => w.worst_phonemes?.[0]?.phoneme).filter(Boolean)), 'phoneme'),
  };
}

const cell = (v) => (v === null ? '-' : String(v));

export function formatProgress(p, since) {
  if (!p.sessions.length) return `No sessions since ${since}.\n`;
  const lines = [`Sessions since ${since}: ${p.sessions.length}`, 'date        mode      pron  acc   flu   pros  wpm'];
  for (const s of p.sessions) {
    lines.push([s.date.padEnd(11), String(s.mode ?? '-').padEnd(9), ...['pronunciation', 'accuracy', 'fluency', 'prosody', 'wpm'].map((m) => cell(s[m]).padEnd(5))].join(' ').trimEnd());
  }
  lines.push('', 'Average (change first to last):');
  for (const m of METRICS) {
    const { avg, change } = p.metrics[m];
    if (avg === null) continue;
    lines.push(`  ${m.padEnd(13)} ${avg}${change === null ? '' : ` (${change > 0 ? '+' : ''}${change})`}`);
  }
  if (p.repeatedWords.length) lines.push('', `Words that keep coming back: ${p.repeatedWords.map((w) => `${w.word} x${w.count}`).join(', ')}`);
  if (p.repeatedPhonemes.length) lines.push(`Worst phonemes that repeat: ${p.repeatedPhonemes.map((w) => `${w.phoneme} x${w.count}`).join(', ')}`);
  return `${lines.join('\n')}\n`;
}
