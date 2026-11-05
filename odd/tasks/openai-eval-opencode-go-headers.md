# Feature: openai-eval sends the headers OpenCode Go requires

## Objective
Upstream contribution: `openai-eval.mjs` identifies itself and sends a session ID when the
endpoint is OpenCode Go, so evaluations through that OpenAI-compatible gateway stop failing.

## Problem / why
The user's local patch (commit 7a219e50, 2026-10-08) added `x-opencode-session` and a
`User-Agent` for `opencode.ai`, after observing `HTTP 400 MissingSessionID` without them.
The v1.38.0 update replaced the file and dropped the patch (backup: openai-eval.mjs.bak).
Contributing it upstream stops every update from deleting it.

Source (read 2026-10-25): https://opencode.ai/v2/docs/console/go/#where-can-i-use-it
"Identify itself with its own user agent, such as my-coding-agent/1.0, rather than a generic
SDK or HTTP-library name." / "Send a stable session ID in x-opencode-session for each
conversation so we can optimize routing and prompt caching."

## Scope / constraints
- Worktree D:/Repos/career-ops-worktrees/fix-openai-eval-opencode-go, branch
  `fix/openai-eval-opencode-go-headers` from upstream/main dff0d65e. Push to fork, PR upstream.
- Bug-fix framing (an OpenAI-compatible endpoint fails with HTTP 400) → straight PR.
- Host-gated to opencode.ai: nothing changes for OpenRouter, OpenAI or local endpoints.
- Session ID: one per run (one evaluation = one conversation, per the docs), not a constant.
- Headers built by a small pure helper so they can be unit-tested without network.
- New test file under tests/. Full suite with `env -u CAREER_OPS_DATA_DIR`. No Co-Authored-By.
- This document stays untracked.

## TDD
Strict (session config). Runner: `node test-all.mjs`; single file `node --test tests/<f>.test.mjs`.

## Tasks
- [x] T1 — helper + wiring + test + one-paragraph doc in docs/RUNNING_ON_A_BUDGET.md.
      Route: delegated direct (writer trigger: 2+ non-trivial files).
- [x] T2 — full suite, commit, push, PR. Route: inline.

## Acceptance criteria
- opencode.ai host → `x-opencode-session` (per-run, stable within the run) + own `User-Agent`.
- Any other host → headers identical to before.
- Live call to OpenCode Go not re-verified here (needs the user's key; not authorized).

## RDD
Off (global).

## Progress / evidence
- T1: new lib/endpoint-headers.mjs, openai-eval.mjs +11, tests/endpoint-headers.test.mjs
  (16 tests; RED ERR_MODULE_NOT_FOUND → 14/16 → 16/16), docs paragraph.
  Full suite (isolated, --jobs 4): 17609 passed, 2 failed — doctor-cli-resolution #10/#11
  (environmental). Parent then reworded comments/doc: "requires"/"answers 400" → docs "ask",
  400 marked as observed 2026-10-08; re-ran node --check and the new file (16/16).
- T2: commit 866034f5, PR https://github.com/career-ops-hq/career-ops/pull/5825 (2026-10-25).

## Next step
Await review. After #5754 and #5825 ship in a release, delete d:/Repos/career-ops/openai-eval.mjs.bak
and drop the local-patch note from the user's modes/_custom.md "OpenCode Go route".
