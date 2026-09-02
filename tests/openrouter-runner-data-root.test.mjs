// tests/openrouter-runner-data-root.test.mjs — openrouter-runner.mjs must honor
// CAREER_OPS_DATA_DIR / CAREER_OPS_ROOT for the user's personal data, the same
// way every other career-ops entrypoint does (see openai-eval.mjs's own
// ROOT/DATA_ROOT split).
//
// Before this fix, every user-data read (cv.md, config/profile.yml,
// modes/_profile.md, portals.yml, data/pipeline.md, data/scan-history.tsv,
// data/applications.md, reports/) resolved against __dirname — the script's
// own directory — never against getCareerOpsRoot(). A user who externalizes
// their data per the project's own documented convention (CAREER_OPS_DATA_DIR,
// or a .career-ops-data marker file) got every one of those reads silently
// miss: readFile() returns null on a miss, and buildSystemPrompt()'s
// `.filter(Boolean)` just drops the empty section — so an evaluation ran with
// no CV and no profile in the prompt, no error, no warning.
//
// parsePortals() is the one already-exported function that reads a DATA_ROOT
// file with no network call and no side effect, so it is the functional proof
// here; a subprocess (not an in-process import) keeps DATA_ROOT resolution —
// computed once at module load — isolated to this one env, matching the
// subprocess pattern the sibling openrouter-tracker-tsv.test.mjs already uses
// for the same reason.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { pass, fail, NODE, ROOT } from './helpers.mjs';

console.log('\nopenrouter-runner.mjs — honors CAREER_OPS_DATA_DIR for user data');

const work = mkdtempSync(join(tmpdir(), 'cops-or-dataroot-'));
try {
  // A minimal portals.yml — one recognizable tracked company — living ONLY in
  // the fixture DATA_ROOT, never in the repo. If parsePortals() still reads
  // __dirname, this company is invisible and the assertion below fails.
  writeFileSync(join(work, 'portals.yml'), [
    'title_filter:',
    '  positive: ["Engineer"]',
    'tracked_companies:',
    '  - name: "Data Root Canary Inc"',
    '    api: "https://example.invalid/canary/jobs"',
    '',
  ].join('\n'));

  const probe = `
    import { parsePortals } from ${JSON.stringify(join(ROOT, 'openrouter-runner.mjs'))};
    const { companies } = parsePortals();
    process.stdout.write(JSON.stringify(companies));
  `;

  let out = '';
  try {
    out = execFileSync(NODE, ['--input-type=module', '-e', probe], {
      encoding: 'utf-8', timeout: 15000,
      env: { ...process.env, CAREER_OPS_DATA_DIR: work },
    });
  } catch (e) {
    fail(`parsePortals() subprocess crashed: ${String(e.stderr ?? e.message).trim().split('\n').pop()}`);
    out = '[]';
  }

  let companies = [];
  try { companies = JSON.parse(out); } catch { /* leave empty, asserted below */ }

  if (companies.some(c => c.name === 'Data Root Canary Inc')) {
    pass('parsePortals() reads portals.yml from CAREER_OPS_DATA_DIR, not __dirname');
  } else {
    fail(`parsePortals() did not see the fixture company — got: ${out.trim()}`);
  }
} finally {
  try { rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ }
}

// Source guard: every user-data accessor this fix touched must resolve through
// the DATA_ROOT-scoped helpers, not the __dirname-scoped ones. Mirrors the
// header-row guard at the end of openrouter-tracker-tsv.test.mjs — if a future
// edit reintroduces readFile('cv.md') (say, a merge conflict resolved the
// wrong way), this fails loudly instead of silently regressing.
const src = readFileSync(join(ROOT, 'openrouter-runner.mjs'), 'utf-8');
const mustUseDataRoot = [
  ["readDataFile('cv.md')", 'cv.md'],
  ["readDataFile('config/profile.yml')", 'config/profile.yml'],
  ["readDataFile('modes/_profile.md')", 'modes/_profile.md (user layer per the Data Contract)'],
  ["readDataFile('portals.yml')", 'portals.yml'],
  ["readDataFile('data/pipeline.md')", 'data/pipeline.md'],
  ["readDataFile('data/scan-history.tsv')", 'data/scan-history.tsv'],
  ["readDataFile('data/applications.md')", 'data/applications.md'],
];
const missing = mustUseDataRoot.filter(([needle]) => !src.includes(needle));
if (missing.length === 0) {
  pass('every user-data read site uses the DATA_ROOT-scoped helper');
} else {
  fail(`still __dirname-scoped: ${missing.map(([, label]) => label).join(', ')}`);
}

// The mode files that ship with the script (system layer, auto-updated) must
// stay __dirname-scoped — a well-meaning global find/replace could just as
// easily over-correct these into DATA_ROOT, which would break them for anyone
// who has NOT copied modes/_shared.md into their personal data directory.
const mustStaySystemLayer = [
  ["readFile('modes/_shared.md')", 'modes/_shared.md'],
  ["readFile('modes/oferta.md')", 'modes/oferta.md'],
  ["readFile('modes/auto-pipeline.md')", 'modes/auto-pipeline.md'],
  ["readFile('modes/apply.md')", 'modes/apply.md'],
];
const overCorrected = mustStaySystemLayer.filter(([needle]) => !src.includes(needle));
if (overCorrected.length === 0) {
  pass('system-layer mode files stay __dirname-scoped (not moved to DATA_ROOT)');
} else {
  fail(`system-layer mode file(s) incorrectly moved to DATA_ROOT: ${overCorrected.map(([, label]) => label).join(', ')}`);
}
