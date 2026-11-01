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
- [ ] **T2 `record`:** SoX `waveaudio` with silence detection, `record_device`, thresholds in YAML;
  `doctor` checks `sox` on PATH and a 2 s non-silent test recording; mic-permission message.
- [ ] **T3 `assess` (REST, ≤30 s):** scripted vs free mode, parameters (HundredMark, Phoneme, EnableMiscue,
  prosody, IPA), summary JSON (scores, timing/WPM/long pauses, words_to_fix ≤3, prosody_flags, omitted/inserted)
  + fixture-based tests.
- [ ] **T4 `assess` continuous (SDK, >30 s):** same summary from a WAV 16 kHz mono; auto-select REST vs SDK;
  `--audio` conversion via ffmpeg for phone files; usage counter in seconds.
- [ ] **T5 `drill` and `progress`:** `drill --reference-file [--listen-first]` (reuses `read`), `progress --since`.
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
`node --test voice/test/` per task; `node test-all.mjs` at feature close.

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

## Next step
On the machine with the microphone, record 15 s with no silence effect (quiet 0-3 s, speech 3-12 s, quiet 12-15 s), compare
RMS per 50 ms window for speech vs quiet, and replay `silence 1 0.3 <th> 1 3 <th>` at 1%, 0.5%, 0.3%, 0.2% and 0.1%. Choose the
threshold from that data, or investigate live input if speech is loud. Then close T2 and go to T3. The fixtures in
`tests/fixtures/voice/` are committed for T3.
