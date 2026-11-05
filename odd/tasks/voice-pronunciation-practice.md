# Feature: voice-pronunciation-practice (record, assess, drill with Azure pronunciation assessment)

Source plan: `voice/plans/02-pronunciacion.md` (authoritative for detail; this file tracks execution).
Depends on: `odd/tasks/voice-tts-questions.md` (T2-T6 done: config, TTS client, `say`/`read`, skill).

## Objective
Let the user read a script or answer freely out loud, and get Azure pronunciation, fluency, prosody and
word/phoneme scores plus a WPM/pause analysis, integrated into `interview/practice` (`answer_mode: spoken`).
Windows, en-US.

## Problem / why
- Without measurement the user cannot tell which words/sounds fail or whether rhythm/intonation fit an interview.
- The agent cannot record audio, so `voice.mjs record` (SoX) must; free answers over 30 s need the Speech SDK.

## Scope / constraints
- Authorized: extend `voice/` (record, assess, drill, progress, lib/*), `voice/package.json` (adds
  `microsoft-cognitiveservices-speech-sdk`), `config/voice.yml` keys, skill section, `_custom.md` rule extension.
- NOT authorized: core `package.json`, system-layer files, committing recordings/keys/fixtures with personal voice data.
- Add host `{region}.stt.speech.microsoft.com` to the allow-list. Recordings in `output/voice/recordings/`
  (gitignored); `keep_recordings: false` default. Voice is sent to Azure: tell the user once.
- Assessment output is a summarized JSON in `output/voice/assessments/`; `interview-prep/sessions/` format unchanged.
- Max 3 words to fix per answer; thresholds configurable (accuracy <60, prosody <70, WPM outside 120-160).
- TDD: strict (user config); network-free tests from a recorded fixture. Runner as fixed in the TTS feature.
- Delivery: work-unit commits on `feat/voice-pronunciation-practice`, stacked on the TTS branch. Conventional Commits.
  Forecast ~800 authored lines, so a chain/slice strategy question applies (`ask-on-risk`).

## Open decisions (ask the user, one at a time, before the dependent task)
- Recording method: `sox` (recommended) vs phone file via `assess --audio` + ffmpeg (before T2).
- Default `answer_mode`: `spoken` or `typed` (before T6).
- Keep recordings? Default no.

## Tasks
- [x] **T1 Smoke test (manual, user-assisted):** ~20 s WAV to REST with/without reference text, prosody + IPA;
  record which fields F0 really returns (prosody, break errors, phonemes) and pricing/F0 availability.
  Save a de-identified response as test fixture. Adjust summary shape to the real fields.
- [x] **T2 `record`:** SoX `waveaudio` with silence detection, `record_device`, thresholds in YAML;
  `doctor` checks `sox` on PATH and a 2 s non-silent test recording; mic-permission message.
- [x] **T3 `assess` (REST, ≤30 s):** scripted vs free mode, parameters (HundredMark, Phoneme, EnableMiscue,
  prosody, IPA), summary JSON (scores, timing/WPM/long pauses, words_to_fix ≤3, prosody_flags, omitted/inserted)
  + fixture-based tests.
- [x] **T4 `assess` continuous (SDK, >30 s):** same summary from a WAV 16 kHz mono; auto-select REST vs SDK;
  `--audio` conversion via ffmpeg for phone files; usage counter in seconds.
- [x] **T5 `drill` and `progress`:** `drill --reference-file [--listen-first]` (reuses `read`), `progress --since`.
- [ ] **T6 Integration:** `answer_mode` setting, transcript-correction step, "Pronunciación y tono" block,
  skill section, `_custom.md` rule extension.
- [ ] **T7 Real run:** 3 questions in `answer_mode: spoken`; verify acceptance criteria below.

## Acceptance criteria (plan §8)
- A 2-3 sentence drill returns scores and ≤3 words to fix with the failing phoneme.
- A 90 s free answer records itself (stops on silence), transcribes and is assessed.
- One recording yields both content feedback and the pronunciation/tone block in `interview/practice`.
- Transcript is correctable before content feedback. `progress` shows evolution over sessions.
- No recording or key enters git; `node test-all.mjs` still passes.

## Applicable checks
`node --test tests/voice-*.test.mjs` per task; `node test-all.mjs` at feature close.

## Progress / evidence
- 2026-10-30: dependency met (voice-tts-questions T2-T7 committed; T8 real run still pending there). Branch
  `feat/voice-pronunciation-practice` created from `feat/voice-tts-questions` (6cd5883e). RDD off (global): no native review.
- Decision (user): recording method is SoX. Installed SoX 14.4.2 with `winget install ChrisBagwell.SoX`
  (Chocolatey has no exact `sox` package; winget adds an alias, a shell restart is needed for PATH).
  2 s test via `waveaudio default` succeeded with exit 0, max amplitude 0.0226 with nobody speaking; speech level not yet observed.
- **T1 (2026-10-31), route inline.** User-run script (scratchpad, not committed), northeurope, REST, 20 s fixed cut that
  truncated the reading. Fixtures: `tests/fixtures/voice/assessment-{scripted,free}.json` (neutral script, no audio).
  Returned: top-level `SNR`; NBest `AccuracyScore, FluencyScore, ProsodyScore, CompletenessScore, PronScore`; word
  `AccuracyScore, ErrorType (None/Mispronunciation/Insertion/Omission), Offset, Duration, Syllables, Phonemes`
  (IPA, with `NBestPhonemes`), `Feedback.Prosody.{Break,Intonation}`. Scores are flat on NBest, no nested
  `PronunciationAssessment`. Offsets are 100 ns ticks.
  Design consequences: (1) `Intonation.ErrorTypes` was `Monotone` on 100 % of words in all 4 responses, so a word-level
  flag is useless: do not list them as-is. (2) `Break.ErrorTypes` was always `None`, even with long pauses: compute pauses
  from timing/`BreakLength`. (3) Omitted words have empty Phonemes and pull accuracy down: a cut recording gave accuracy 56
  and 17 false omissions, so fixed cuts must not be used. (4) Free mode misheard "small, well tested changes" as "a small
  world, instantaneous": the transcript-correction step is required. Free-mode completeness is a constant 100: omit it.
  Not verified: resource tier (F0) and pricing.

- **T2 (2026-10-31), route delegated writer (2+ non-trivial files).** Commit 32df8f7b. RED: ERR_MODULE_NOT_FOUND;
  GREEN reported: 89/89 voice tests, `test-all.mjs --only voice` 8 passed. Doctor sox/mic checks are warn, not fail, so
  TTS-only use keeps passing. Real silence-stop with a live mic: pending user run (T2 stays open until observed).
  Risk assessed high (RDD off), so an independent verifier ran: pass with notes. Fixed its findings: `trim` moved before
  `silence` because after it `max` never fires without speech (real sox, 90% threshold: stopped at 4.3 s, exit 0, 44-byte WAV);
  empty recording is now a "no speech" error; failed or empty output is deleted. Left as is: `--out ..foo.wav` is falsely
  rejected (safe; same check exists in `read`).

- **T2 live runs (2026-11-01), still failing.** Commit b3b41810 raised the start window to 0.3 s and added a "speak now"
  prompt, on the unproven theory that the Enter key started the recording. It did not fix it: the user spoke right at start
  and got 0.4 s. That WAV has flat, low levels (RMS 0.010-0.018, peak 0.032) against a 1% threshold. SoX silence logic is
  correct on files (0.3 amplitude tone kept whole; 0.005 amplitude tone gives empty output). Hypothesis, not proven: speech
  reaches SoX below the 1% threshold. Live input handling by SoX is not ruled out.
- **T2 closed (2026-11-03).** Measured 15 s on the real mic, RMS per 50 ms: room p50 0.0001, speech p50 0.0026 (below 1%),
  plus a stray ~0.4 s noise at 0.04 while quiet; mic open has no transient. Replaying `silence` gave 0.42 s at 1% and 0.98 s
  at 0.3%: any noise starts it and the gap before speech ends it. Decision (user): detect speech in Node. Commit 69478e6a,
  route delegated writer: sox streams raw PCM; threshold = max(record_silence_threshold, min(4 x calibration noise, 1%)),
  default minimum 0.15%; stop after `record_stop_silence_s` only once 1 s of speech accumulated; trailing silence trimmed to
  0.5 s; no speech by max deletes the file. RED: missing export; GREEN: 104/104 voice tests, `--only voice` 8/8 (parent re-ran
  104/104). Real checks: 5 s quiet run reported no speech and left no file; user speech run recorded 16.1 s.

- **Delivery strategy (2026-11-03, user): `stacked-to-main`.** main...HEAD is 25 files, +2904 (includes the stacked TTS base).
  Slices: (1) TTS base aee60147..6cd5883e, (2) T2 record 32df8f7b..464f07e9 + fixtures, (3) T3+ in PRs of ~400 authored lines
  each. Each PR targets the previous one, then main. No push without asking. Engram mirror `odd/voice-pronunciation-practice/tasks`:
  not found at T3 start (search empty); mirror pending.
- **T3 route (2026-11-03):** delegated writer (2+ non-trivial files: `voice/lib/assess.mjs`, `voice.mjs` wiring, config keys, tests).
  Tests live in `tests/voice-*.test.mjs` (not `voice/test/`); runner `node --test tests/voice-*.test.mjs`.

- **T3 (2026-11-04), delegated writer.** RED: ERR_MODULE_NOT_FOUND for voice/lib/assess.mjs (later two old stub tests
  failed as expected and were updated). GREEN: 123/123 voice tests (parent re-ran),  9/9 reported.
  ~470 authored lines (tests 271, code ~200), over the ~400 heuristic; not trimmed. Fixture-derived rules enforced by tests
  (flat NBest scores, 100 ns ticks, no per-word Monotone, pauses from timing gaps, omissions excluded from words_to_fix).
  New config keys assess_{accuracy_min,prosody_min,wpm_min,wpm_max,long_pause_s,max_words}. **Open:** live REST call not run
  (request shape, Content-Type sample rate, format=detailed unverified against Azure), so T3 stays unchecked until one real
  smoke run; pace/pause rules are interpretation, not checked on real audio. Risk tier not assessed (RDD off); no verifier run.

- **T3 live run (2026-11-04), closed.** Free mode on a 16.1 s recording (user-authorized, sent to Azure): REST accepted the request, JSON written to the data root. Pron 74.2, accuracy 86, fluency 76, prosody 69.6; 2 words to fix with IPA; one 1.9 s pause; 78 WPM (flagged slow). Request shape, Content-Type and format=detailed are now verified. Note: timing.duration_s (11.6) is the spoken span, not the file length. Scripted mode not run live.

- **T4 (2026-11-04), route delegated writer** (trigger: 2+ non-trivial files: `voice/lib/assess-sdk.mjs`, `voice/lib/audio.mjs`,
  `assessCmd`, usage, tests). SDK API checked first against current Microsoft docs (context7): `PronunciationAssessmentConfig.fromJSON`
  + `enableProsodyAssessment`, `SpeechRecognizer` continuous events, `SpeechServiceResponse_JsonResult`. Discovery: SDK segment JSON
  nests scores under `PronunciationAssessment` (REST is flat), so a normalizer accepts both. Overall scores recomputed across segments
  per Microsoft's language-learning JS sample. Scripted SDK mode sends `enableMiscue: false` and aligns words to the reference (LCS)
  after merging; a substituted word counts as omission + insertion (stricter than Azure's miscue). Commit dcceac07, +900/-29
  (~700 tests + fixture; over the ~400 heuristic, not trimmed). RED: ERR_MODULE_NOT_FOUND for assess-sdk.mjs/audio.mjs.
  GREEN: 157/157 voice tests (parent re-ran 157/157), `test-all.mjs --only voice` 11/11 reported.
  `voice/package.json` declares the SDK (^1.53.0, ~5.6 MB unpacked); **not installed**. ffmpeg not installed on the machine.
  **Open:** live SDK run over 30 s not done (segment shape, absolute offsets across segments, EndOfStream handling unverified);
  ffmpeg conversion tested only with a fake spawn. T4 stays unchecked until a live run. Risk not assessed (RDD off); no verifier.

- **T4 live SDK run (2026-11-05).** User approved installing the SDK: `npm install` in `voice/` (1.53.0, 13 MB on disk, 0
  vulnerabilities; `node_modules` and `package-lock.json` are gitignored). First live run failed: `pa.enableProsodyAssessment is
  not a function`. In the JS SDK it is a setter (1.53.0 `PronunciationAssessmentConfig.d.ts`); the docs snippet passed to the
  writer was wrong for JS and the fake mirrored it. Fixed inline (1 file + test): fake changed to a setter, RED observed (same
  error, 5 failing), GREEN 157/157. Second run, free mode, 99.3 s WAV (user-authorized, sent to Azure): pron 77.2, accuracy
  91.6, fluency 80.1, prosody 71.4; 3 words to fix with IPA; one 1.2 s pause; 111 WPM (flagged slow); usage ledger got
  `assess 99.3`. Verified live: nested segment shape with IPA phonemes, offsets absolute across segments (spoken span 97.7 s of
  99.3 s), EndOfStream finish. Still open: ffmpeg conversion of a phone file (ffmpeg not installed), and scripted mode over SDK.

- **T4 closed (2026-11-05).** User installed ffmpeg 9.0.2 (winget Gyan.FFmpeg; shells opened before the install lack it on
  PATH). Real conversion, local only: the 16.1 s WAV encoded to stereo 44.1 kHz AAC `.m4a` (simulated phone file), then
  `convertToWav` gave PCM 16 kHz mono 16-bit, 16.1 s, `isSpeechReadyWav` true; `checkFfmpeg` ok; `doctor` "ffmpeg found on PATH".
  Not sent to Azure again: REST and SDK paths are already verified live, and the conversion-to-assess wiring is fake-tested.
  Still not run live: scripted mode over the SDK (LCS miscue alignment).

- **Delivery (2026-11-05, user):** T3+T4 shipped together in draft PR #3 (`feat/voice-pronunciation-practice` -> `feat/voice-record`),
  ~1.4k lines incl. tests. The unrelated ODD-docs commit e4646507 was moved to main (user, 2026-11-05). T5 deferred by the user.

- **T5 start (2026-11-05).** Branch `feat/voice-drill-progress` from 0092c200 (tip of PR #3); T5 ships in a new PR -> #3.
  Decision (user): add `keep_recordings` to `config/voice.yml`, default `false`; `drill` deletes its WAV after assessing
  and keeps only the summary JSON. `record` and `assess` keep files as before (they act on files the user names).
  Defaults chosen without a user decision: `progress --since` accepts `YYYY-MM-DD` or `Nd` (default `30d`), session date
  from the JSON filename prefix; the drill reference is cleaned with `cleanMarkdown` before being sent as ReferenceText.
  Route: delegated writer (trigger: 2+ non-trivial files: `voice/lib/progress.mjs`, `drillCmd`/`progressCmd` in
  `commands.mjs`, config key, CLI wiring, tests). TDD strict, runner `node --test tests/voice-*.test.mjs`.

- **T5 implementation (2026-11-05), delegated writer.** Commit 3f7a351c, +530/-41 (tests 341; over the ~400 heuristic, not
  trimmed). RED: ERR_MODULE_NOT_FOUND for `voice/lib/progress.mjs`; drill tests failed with `"drill" is not implemented yet`.
  GREEN: 175/175 voice tests (parent re-ran 175/175), `test-all.mjs --only voice` 13/13 reported; empty data root
  `progress --since 2000-01-01` printed "No sessions since 2000-01-01." exit 0. Refactor: `assessCmd` body moved to an internal
  `runAssessment({ audioPath, reference, ... })` (reference as text) shared with `drill`; `recordCmd` uses a shared `recordTo()`
  with a `deps.recordImpl` seam. Writer's choices: `drill` has no `--max` (uses `record_max_s`); `--locale` affects the assessment
  only, `--listen-first` playback uses the persona locale. `progress` counts repeats once per session (2+ sessions), has `--json`.
  Two old "not implemented" tests were replaced. Risk not assessed (RDD off); no verifier. **Open:** live scripted `drill` run
  (REST) not done; T5 stays unchecked until it is observed.

- **T5 closed (2026-11-05), live run.** User-confirmed send to Azure. `drill --listen-first` on a 2-sentence neutral reference
  (scratchpad, not committed): TTS played, recording stopped on silence, REST scripted assessment, exit 0. Pron 82.3, accuracy 87,
  fluency 81, prosody 76.2, completeness 91; 120 WPM; no long pauses; 0 words to fix (none below 60, no Mispronunciation).
  Miscue detection verified live: real misreads reported (omitted `a`, `in`; inserted `that`, `into`). WAV deleted
  (`keep_recordings` default false). `progress --since 30d` listed the 3 real sessions with averages and first-to-last change
  (pron +8.1); no repeated words yet. Scripted mode over REST is now verified live; scripted over the SDK (>30 s, LCS alignment)
  is still not run live. Noted, not changed: drill's console summary does not print omitted/inserted (they are in the JSON).

## Next step
T5 done. Ask the user before pushing `feat/voice-drill-progress` and opening a draft PR -> #3. Then T6 (ask default
`answer_mode` first).
Stacked-to-main PR slicing agreed; no push yet.
