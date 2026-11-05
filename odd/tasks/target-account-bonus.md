# Feature: target-account score bonus + re-evaluation

## Objective
+0.5 Global-score bonus for the 22 target accounts, applied by the OpenRouter evaluator,
and re-evaluate the tracked offers it could move across the apply line.

## Scope / constraints
- Rule lives in the user's `modes/_custom.md` → `## Scoring Rules` (read by openai-eval since
  the local update 489482ef brought #5754). Company list inline: the evaluator does not read
  `data/target-accounts.md`.
- No bonus below North Star 3/5; never overrides hard blockers.
- Re-eval with `openai-eval.mjs --url openrouter --model z-ai/glm-5.3` directly:
  `tools/eval-or.sh` reuses `CAREER_OPS_ROOT` for the code path, which career-ops also reads
  as the data-root override.
- Tracker has no URL column: inject `posting NNNN` into each addition's notes so the req-ID
  guard keeps the four near-identical Factorial rows apart; `merge-tracker --dry-run` first.

## Tasks
- [x] T1 — rule in `_custom.md` (+ OpenCode Go note corrected). Verified in
      buildBudgetedPrompt: section present, nothing trimmed. Not committed.
- [x] T2 — liveness: 5/5 active (288855, 312428, 312427, 306774, 329466).
- [x] T3 — JDs extracted to `jds/factorial-*.md` (browser-extract --mode jd).
- [x] T4 — 5 re-evals with glm-5.3: reports 435-439, JD archived in each.
- [x] T5 — merged as 5 updates, 0 added (#13 3.7→4.0, #160 3.8→4.0, #149 3.4→4.4,
      #155 3.5→4.5, #386 3.6→4.3). Fuzzy tier failed at first: with no URL column a row's
      URL comes from its report header, and old reports say careers.factorialhr.com while the
      new ones say careers.factorial.com (a redirect). Fixed by giving each addition the old
      URL, the row's exact role, and (for #13/#386) the target row number. verify-pipeline
      still reports pre-existing dead report links on unrelated rows (#300, #318, #331…).

## Rows in scope
#13 (288855) · #160 (312428) · #149/#385 (312427) · #155 (306774) · #386 (329466)
