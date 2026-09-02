// tests/openrouter-runner-pinned-timeout.test.mjs — a PINNED model
// (CAREER_OPS_MODEL) needs a timeout long enough for a real evaluation to
// finish, not the free-rotation path's fast-fail-and-try-the-next-model 15s.
//
// A pinned model has no fallback to move to, and the full A-G evaluation
// prompt (CV + profile + _shared.md + oferta.md) is tens of thousands of
// tokens — 15s isn't enough for that with any model, reasoning or not.
// Reproduced live before this fix: even claude-haiku-4.5 (non-reasoning, no
// thinking-token overhead) timed out at 15s on a real posting; with the
// default raised to match openai-eval.mjs's own 300s OPENAI_TIMEOUT_MS, the
// identical call completed cleanly.
//
// This test does not wait out a real 300s default (or spend real API budget)
// to prove the fix — it proves the override wiring is correct by setting
// CAREER_OPS_MODEL_TIMEOUT_MS to an absurdly small value and asserting the
// call aborts near-instantly with a message reporting that exact value, which
// only happens if the new env var is actually read and threaded through to
// the pinned model's AbortController. A fake OPENROUTER_API_KEY is enough:
// the code only checks the key is present before attempting the request, and
// the 1ms timeout aborts before any response — valid or not — comes back.
import { readFileSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { pass, fail, NODE, ROOT } from './helpers.mjs';

console.log('\nopenrouter-runner.mjs — pinned-model timeout is configurable');

const RUNNER = join(ROOT, 'openrouter-runner.mjs');

function runPinned(envOverrides) {
  // cmdEvaluate's error path is console.error (stderr) + `return null`, not a
  // thrown error or a non-zero exit — spawnSync (not execFileSync) so both
  // streams come back regardless of exit code.
  const r = spawnSync(NODE, [RUNNER, 'evaluate', 'placeholder JD text, never reaches the model'], {
    encoding: 'utf-8', timeout: 10000,
    env: {
      ...process.env,
      OPENROUTER_API_KEY: 'sk-or-v1-test-key-not-a-real-credential',
      CAREER_OPS_MODEL: 'fake/does-not-matter-aborts-before-response',
      ...envOverrides,
    },
  });
  return (r.stdout ?? '') + (r.stderr ?? '');
}

const out1ms = runPinned({ CAREER_OPS_MODEL_TIMEOUT_MS: '1' });
if (/Pinned model timed out after 0\.001s/.test(out1ms)) {
  pass('CAREER_OPS_MODEL_TIMEOUT_MS=1 aborts at 1ms, not the old 15s default');
} else {
  fail(`expected a 0.001s timeout message, got: ${out1ms.trim().split('\n').slice(-3).join(' | ')}`);
}

// Invalid overrides must not crash the whole run (module-scope parsing, not a
// throw/exit) — they silently fall back to the 300s default instead. A
// negative or non-numeric value here must NOT reproduce the near-instant
// abort above; if it did, the fallback isn't actually protecting anything.
for (const bad of ['not-a-number', '-5', '0']) {
  const out = runPinned({ CAREER_OPS_MODEL_TIMEOUT_MS: bad });
  if (/Pinned model timed out after 0\.001s/.test(out)) {
    fail(`CAREER_OPS_MODEL_TIMEOUT_MS="${bad}" was NOT rejected — it produced the 1ms-override abort message`);
  } else {
    pass(`CAREER_OPS_MODEL_TIMEOUT_MS="${bad}" falls back to the default instead of misbehaving`);
  }
}

// Source guard: the free-rotation path (no CAREER_OPS_MODEL pinned) must keep
// its own fast, unrelated 15s timeout — this fix only touches the pinned path.
const src = readFileSync(RUNNER, 'utf-8');
if (/const MODEL_TIMEOUT_MS\s*=\s*15_000/.test(src) && /PINNED_MODEL_TIMEOUT_MS/.test(src)) {
  pass('free-rotation path keeps its own 15s timeout; pinned path gets a separate, configurable one');
} else {
  fail('expected both MODEL_TIMEOUT_MS = 15_000 (free rotation) and a separate PINNED_MODEL_TIMEOUT_MS to coexist');
}
