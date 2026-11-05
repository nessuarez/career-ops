# Feature: standalone evaluators load modes/_custom.md

## Objective
Upstream contribution (career-ops-hq/career-ops): every standalone evaluator passes the
user's `modes/_custom.md` to the model, so its house rules and Scoring Rules apply.

## Problem / why
`modes/_shared.md` reads `_custom.md` "ALWAYS" (line 31) and applies its Scoring Rules to
the Global score (line 89). `batch/batch-prompt.md` honours it, but `openai-eval.mjs`,
`gemini-eval.mjs`, `ollama-eval.mjs` and `batch-evaluate-gemini.mjs` never load it, so
evaluations through OpenRouter / OpenAI-compatible / Gemini / Ollama ignore those rules.
Found while trying to add a target-account score bonus (2026-10-23).

## Scope / constraints
- Bug fix → straight PR, no issue (CONTRIBUTING.md "Before Submitting a PR").
- Worktree: D:/Repos/career-ops-worktrees/fix-evaluators-custom-md, branch
  `fix/evaluators-custom-md` from upstream/main 374eff1e. Push to fork `origin`
  (nessuarez/career-ops), PR to upstream.
- `_custom.md` is optional (an absent file is a valid end state): no warning, no section.
- New tests in their own file under `tests/` (CONTRIBUTING.md "Development").
- Full `node test-all.mjs` before pushing. No personal data. No Co-Authored-By in commits.
- This document stays untracked; it is not part of the PR.

## TDD
Mode: strict (source: session config "Strict TDD Mode: enabled"). Runner: `node test-all.mjs`
(single file: `node --test tests/<file>.test.mjs`).

## Tasks
- [x] T1 — `lib/context-budget.mjs`: `customContent` option → non-compressible `_custom.md`
      section; evaluators pass it (absent file → ''). Test guards wiring for all four.
      Route: delegated direct (writer trigger: 2+ non-trivial files).
- [x] T2 — Full suite, commit, push to fork, open PR to upstream.
      Route: inline (git/gh state).

## Acceptance criteria
- `buildBudgetedPrompt({ customContent })` emits a `_custom.md` section; omitted when empty.
- All four evaluators read `{DATA_ROOT}/modes/_custom.md` when present and pass it.
- Missing `_custom.md` → no section, no warning.
- New test file passes; full suite has no new failures vs upstream/main.

## RDD
Off (global). Functional checks only.

## Progress / evidence
- T1 (delegated writer, 2026-10-23): +29/-1 across lib/context-budget.mjs and the four
  evaluators, plus new tests/evaluators-custom-md.test.mjs (9 tests: section present/absent,
  survives compression, gemini-eval --context-only behavioural check, source drift guard
  incl. profileContent). RED 8/9 failing before source changes; GREEN 9/9.
  Full suite (writer, default parallelism): 17229 passed, 6 failed — doctor-cli-resolution
  (2), updater-dependency-install (3), Dashboard build (1). The first two pass in isolation
  both on a clean stash and with the change; parent re-run with --jobs 4 pending.
  batch-evaluate-gemini prompt is byte-identical when _custom.md is absent (parent review).

- Parent full suite, real data root unset, --jobs 4: 17233 passed, 2 failed — doctor-cli-resolution
  #10/#11 (git "dubious ownership" at C:/Users/<user>, environmental; pass in isolation on base
  and change). An earlier run's "changed the real data root" was a concurrent evaluation session
  (reports 386/387, opencode-go) writing during the run, not the tests.
- T2: commit 14183339 on fix/evaluators-custom-md, pushed to fork; PR
  https://github.com/career-ops-hq/career-ops/pull/5754 (2026-10-23).

## Next step
Await maintainer review. Locally, openai-eval.mjs still lacks #5202 and this fix (update-system
preserved it over the OpenCode Go header commit); reconcile after merge, then add the
target-account Scoring Rule to modes/_custom.md.
