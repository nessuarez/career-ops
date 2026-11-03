// Azure Pronunciation Assessment over REST (audio up to 30 s) and the summary of its response.
// The key goes only into the request header; it never appears in errors or logs.
import { isAllowedHost } from './config.mjs';

export const MAX_REST_S = 30;
const TICKS_PER_S = 1e7; // Azure offsets and durations are 100 ns ticks
const EDGE_ERRORS = new Set(['Omission', 'Insertion']);
const redact = (text, key) => (key ? String(text).split(key).join('[redacted]') : String(text));

// Value of the Pronunciation-Assessment header: base64 of the JSON parameters.
// Without a reference text Azure transcribes freely, so miscue detection only applies to scripted mode.
export function buildAssessmentHeader({ reference } = {}) {
  const params = {
    GradingSystem: 'HundredMark',
    Granularity: 'Phoneme',
    Dimension: 'Comprehensive',
    EnableProsodyAssessment: true,
    PhonemeAlphabet: 'IPA',
  };
  if (reference) Object.assign(params, { ReferenceText: reference, EnableMiscue: true });
  return Buffer.from(JSON.stringify(params)).toString('base64');
}

const sampleRateOf = (wav) => (wav.length >= 28 ? wav.readUInt32LE(24) : 16000);

export async function assessAudio({ wav, reference, locale = 'en-US', region, key, fetchImpl = fetch }) {
  const host = `${region}.stt.speech.microsoft.com`;
  if (!isAllowedHost(host, region)) throw new Error(`refusing to call disallowed host for region "${region}"`);
  const url = `https://${host}/speech/recognition/conversation/cognitiveservices/v1?language=${encodeURIComponent(locale)}&format=detailed`;
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': key,
        'Content-Type': `audio/wav; codecs=audio/pcm; samplerate=${sampleRateOf(wav)}`,
        'Pronunciation-Assessment': buildAssessmentHeader({ reference }),
        Accept: 'application/json',
        'User-Agent': 'career-ops-voice',
      },
      body: wav,
    });
  } catch (e) {
    throw new Error(`Azure Speech request failed: ${redact(e?.message ?? e, key)}`);
  }
  if (res.status === 401) throw new Error('Azure Speech returned 401: check AZURE_SPEECH_KEY and AZURE_SPEECH_REGION (the key must belong to that region)');
  if (!res.ok) throw new Error(`Azure Speech assessment returned ${res.status}`);
  return res.json();
}

const round1 = (n) => Math.round(n * 10) / 10;

// Lowest-scoring phonemes of a word, in IPA, below the threshold (or the single worst one).
function worstPhonemes(word, accuracyMin) {
  const ph = (word.Phonemes ?? []).filter((p) => typeof p.AccuracyScore === 'number');
  const low = ph.filter((p) => p.AccuracyScore < accuracyMin).sort((a, b) => a.AccuracyScore - b.AccuracyScore);
  const pick = low.length ? low : [...ph].sort((a, b) => a.AccuracyScore - b.AccuracyScore).slice(0, 1);
  return pick.slice(0, 2).map((p) => ({ phoneme: p.Phoneme, score: p.AccuracyScore }));
}

// Condenses Azure's response (large) into what a coaching answer needs.
// thresholds: { accuracyMin, prosodyMin, wpmMin, wpmMax, longPauseS, maxWords }
export function summarizeAssessment(raw, { mode, locale = 'en-US', thresholds }) {
  const t = thresholds;
  if (raw?.RecognitionStatus !== 'Success') throw new Error(`Azure could not assess the audio (${raw?.RecognitionStatus ?? 'no status'}); check the recording has speech`);
  const best = raw.NBest?.[0];
  if (!best) throw new Error('Azure returned no result for the audio');

  const words = best.Words ?? [];
  const spoken = words.filter((w) => w.ErrorType !== 'Omission');
  const timed = spoken.filter((w) => typeof w.Offset === 'number' && w.Duration > 0);

  const scores = {
    pronunciation: best.PronScore,
    accuracy: best.AccuracyScore,
    fluency: best.FluencyScore,
    prosody: best.ProsodyScore,
  };
  // Free mode reports a constant 100 here: no reference, nothing to complete.
  if (mode === 'scripted') scores.completeness = best.CompletenessScore;

  let durationS = 0;
  const longPauses = [];
  if (timed.length) {
    const end = (w) => w.Offset + w.Duration;
    durationS = (Math.max(...timed.map(end)) - timed[0].Offset) / TICKS_PER_S;
    // Break.ErrorTypes is always None in practice, so pauses come from the gap between word timings.
    for (let i = 0; i + 1 < timed.length; i++) {
      const gap = (timed[i + 1].Offset - end(timed[i])) / TICKS_PER_S;
      if (gap >= t.longPauseS) longPauses.push({ after: timed[i].Word, s: round1(gap) });
    }
  }
  const wpm = durationS > 0 ? Math.round((spoken.length / durationS) * 60) : 0;

  const wordsToFix = words
    .filter((w) => !EDGE_ERRORS.has(w.ErrorType) && (w.ErrorType === 'Mispronunciation' || w.AccuracyScore < t.accuracyMin))
    .sort((a, b) => a.AccuracyScore - b.AccuracyScore)
    .slice(0, t.maxWords)
    .map((w) => ({ word: w.Word, accuracy: w.AccuracyScore, error: w.ErrorType, worst_phonemes: worstPhonemes(w, t.accuracyMin) }));

  // Per-word Intonation was "Monotone" on every word in real responses, so it is not reported;
  // prosody feedback comes from the overall score, the pace and the pauses.
  const prosodyFlags = [];
  if (typeof scores.prosody === 'number' && scores.prosody < t.prosodyMin) prosodyFlags.push({ type: 'low_prosody', score: scores.prosody, min: t.prosodyMin });
  if (wpm && wpm > t.wpmMax) prosodyFlags.push({ type: 'pace_fast', wpm, max: t.wpmMax });
  if (wpm && wpm < t.wpmMin) prosodyFlags.push({ type: 'pace_slow', wpm, min: t.wpmMin });

  return {
    mode,
    locale,
    transcript: raw.DisplayText ?? best.Display ?? '',
    scores,
    timing: { duration_s: round1(durationS), wpm, long_pauses: longPauses },
    words_to_fix: wordsToFix,
    prosody_flags: prosodyFlags,
    omitted: words.filter((w) => w.ErrorType === 'Omission').map((w) => w.Word),
    inserted: words.filter((w) => w.ErrorType === 'Insertion').map((w) => w.Word),
  };
}
