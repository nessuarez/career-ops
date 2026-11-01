# Feature: voice-tts-questions (Azure TTS for interview questions and prepared texts)

Source plan: `voice/plans/01-tts-preguntas.md` (authoritative for detail; this file tracks execution).

## Objective
Fork-owned `voice/` module that speaks interview questions during `/career-ops interview/practice`
and reads prepared texts (`interview-prep/`) aloud for shadowing, using Azure Speech TTS.
Environment decided: Windows, accent en-US.

## Problem / why
- `interview/practice` is text-only; the user wants to hear questions and model answers.
- Plugin engine has no speech hook, plugins cannot spawn processes, and `.claude/skills/`/`.agents/`
  are system paths the updater overwrites, so the module lives outside the engine (plan §1-2).

## Scope / constraints
- Authorized: new `voice/` dir (package.json, voice.example.yml, voice.mjs, lib/*, test/*, skill/SKILL.md),
  `config/voice.yml`, `config/local-paths.txt` (`voice/`), a house rule in `modes/_custom.md`,
  `install-skill` copying to `~/.claude/skills/interview-voice/`.
- NOT authorized: touching system-layer files (`modes/_shared.md`, `plugins/_engine.mjs`, router skill),
  the core `package.json`, or committing keys. No real Azure call without the user's key in `.env`.
- Text enters via file, never shell args (untrusted JD content). Allowed host: `{region}.tts.speech.microsoft.com` only.
- Key never printed or logged.
- TDD: strict (user config). Runner: `node --test "tests/voice-*.test.mjs"` (T2: tests live in tests/ because test-all.mjs only discovers tests/**; bare dir form fails on Node 24). Tests are network-free.
- Task size heuristic ~400 authored lines/task (advisory only).
- Delivery: work-unit commits on a feature branch (branch off `main` before first write; suggested
  `feat/voice-tts-questions`). Conventional Commits. No push/PR without the user's decision.
  Forecast ~700 authored lines total, so `ask-on-risk` chain strategy question applies if the running
  count passes ~400.
- Route per task: inline for single mechanical files; delegated writer for 2+ non-trivial files (record below).

## Open item
- T1 needs the user's Azure key/region in `.env`. Plan 2 depends on T2-T6 here.

## Tasks
- [x] **T1 Smoke test (manual, user-assisted):** call `voices/list` and synthesize one phrase with the real key;
  record region, available en-US voices/styles and F0 behaviour. Output: notes in this file. Route: inline.
- [x] **T2 Config:** `voice.example.yml` + `lib/config.mjs` (reads `config/voice.yml` + `.env` via
  `getCareerOpsRoot()`, validates) + tests. Resolve the test runner here.
- [x] **T3 Azure TTS client:** `lib/azure-tts.mjs` (SSML build with escaping of `& < > " '`, style only if the
  voice supports it via `StyleList`, prosody, REST, `voices/list` cached 7 days, host allow-list,
  401/429/400 handling) + network-free tests (SSML snapshot, escaping, host guard).
- [x] **T4 Player, cache, usage:** `lib/player.mjs` (PowerShell `Media.SoundPlayer`, path as escaped
  argument, `player:` override), WAV cache keyed by hash(text+voice+style+degree+rate+pitch),
  `lib/usage.mjs` (`data/voice-usage.tsv`, warn at 90 % of `monthly_char_budget`) + `say` command + tests.
- [x] **T5 `doctor` and `voices` commands:** key/region, voice+style exist, player present, budget left.
- [x] **T6 `read` command (plan §5b):** Markdown cleanup, `--section`, paragraph chunking with per-paragraph
  cache, `--rate`, `--pause`, `--step`, `--out` to `output/voice/exports/`, `personas.me` + tests.
- [x] **T7 Skill and integration:** `voice/skill/SKILL.md`, `install-skill`, `config/local-paths.txt`,
  `_custom.md` house rule (user layer), verify the updater accepts `voice/`.
- [ ] **T8 Real run:** `/career-ops interview/practice` recruiter round, 3 questions; verify acceptance criteria below.

## Acceptance criteria (plan §9)
- `doctor` green with real key/region.
- Question audible in `interview/practice` without manual steps.
- Changing locale/voice/style/rate/persona in YAML changes the voice with no code change.
- Unsupported style warns, does not fail. Questions with `< & "` sound correct.
- Repeated question served from cache, adds no characters. No key in logs or git.
- `node test-all.mjs` still passes (core untouched).

## Applicable checks
`node --test "tests/voice-*.test.mjs"` per task; `node test-all.mjs` and `node doctor.mjs` at feature close.

## Progress / evidence
- **T1 (2026-10-30), route inline.** Script run by the user (agent read of `.env` was denied by the
  permission classifier, so the user executed it): region `northeurope`, key in
  `D:\Repos\my-profesional-career\career-ops-personal\.env` (data root via `CAREER_OPS_DATA_DIR`), length 84.
  `voices/list` 200, 86 en-US voices; `v1` TTS 200 (WAV 24 kHz). Styles: Jenny (assistant, chat,
  customerservice, newscast, angry, cheerful, sad, excited, friendly, terrified, shouting, unfriendly,
  whispering, hopeful), Guy (same minus assistant/chat/customerservice), Aria (adds empathetic,
  narration-professional, newscast-casual/formal), JennyMultilingual (no styles).
  Not verified: that the user heard the audio; that the resource is actually Free F0 (key works; tier
  not checked). Smoke script was a scratchpad file, not committed.
- Note: the data root differs from the repo root, so `lib/config.mjs` must resolve `.env` and
  `config/voice.yml` through `getCareerOpsRoot()` (plan §3), not `__dirname`.

## Next step
Create branch `feat/voice-tts-questions`, then T2 (config).

- **T2 (2026-10-30), route delegated writer.** Commit 170eeb21. RED: ERR_MODULE_NOT_FOUND before implementation; GREEN: 10/10 via `node --test tests/voice-config.test.mjs` and `node test-all.mjs --only voice-config` (spot-checked by parent). Tests moved to `tests/voice-config.test.mjs` (user decision). Full `node test-all.mjs`: 43 failures, reported as mostly v1.38.0-merge related but NOT verified against clean main; the SYSTEM_PATHS gap for `voice/` is closed in T7. Config uses js-yaml (repo dep).

- **T3 (2026-10-30), route delegated writer.** Commit 40f6ae95. RED: ERR_MODULE_NOT_FOUND; GREEN: 18 tests in `tests/voice-azure-tts.test.mjs`, 28/28 across `tests/voice-*.test.mjs` (spot-checked by parent), `test-all.mjs --only voice` green. Exports buildSsml, synthesize, listVoices, stylesForVoice; 429 retries once after 2000 ms; voices cache `<cacheDir>/voices.json` {fetchedAt, voices}, 7 days.

- **T4 (2026-10-30), route delegated writer.** Commit e56daebe. RED: ERR_MODULE_NOT_FOUND; GREEN: 47/47 `tests/voice-*.test.mjs` (spot-checked by parent). `say --text-file <p> [--persona] [--no-play]` works with injected deps; NOT yet run against real Azure/audio. Windows player passes the wav path via env CAREER_OPS_VOICE_WAV (not argv) because -Command re-parses args. Cache key uses configured style. Over-budget only warns. ~480 lines (282 tests), above 400 heuristic: tests dominate.

- **T5+T6 (2026-10-30), route delegated writer.** Commit aee60147. RED: ERR_MODULE_NOT_FOUND + assertion failures; GREEN: 70/70 `tests/voice-*.test.mjs` (spot-checked by parent), `test-all.mjs --only voice` 6 suites green. Added voice/lib/speak.mjs and voice/lib/commands.mjs (shared say/read path). `read` uses persona --persona, else me, else base. --out must end in .wav; relative paths stay in output/voice/exports/. Not run against real Azure or audio. Over the 400-line heuristic, tests dominate.

- **T7 (2026-10-30), route delegated writer.** Commit 6cd5883e. 75/75 `tests/voice-*.test.mjs` (spot-checked), `test-all.mjs --only voice` 7 green. `install-skill` ran for real: C:\Users
essu\.claude\skills\interview-voice\SKILL.md (1717 bytes). `voice/` added to gitignored config/local-paths.txt; updater accepts it. _custom.md section appended in data root (user layer). Coverage validator shows 3 orphans not from voice/ (close-stale, cli-launch, panelist-roles), unverified against main.

- **T7 (2026-10-30), route delegated writer.** Commit 6cd5883e. 75/75 `tests/voice-*.test.mjs` (spot-checked by parent), `test-all.mjs --only voice` 7 green. `install-skill` ran for real, writing the skill to the user's ~/.claude/skills/interview-voice/SKILL.md (1717 bytes). `voice/` added to the gitignored config/local-paths.txt; updater accepts it. `_custom.md` section appended in the data root (user layer). Coverage validator reports 3 orphans not from voice/ (close-stale, cli-launch, panelist-roles), not verified against main.
