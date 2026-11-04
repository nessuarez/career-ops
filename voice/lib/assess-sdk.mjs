// Pronunciation assessment for audio over 30 s: Azure Speech SDK in continuous recognition,
// then the per-segment results are merged into one REST-shaped object for summarizeAssessment.
// The SDK is loaded lazily and injectable, so nothing here needs it installed to be tested.
import { isAllowedHost } from './config.mjs';

const redact = (text, key) => (key ? String(text).split(key).join('[redacted]') : String(text));
const round1 = (n) => Math.round(n * 10) / 10;
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
const SDK_HINT = 'the Speech SDK is needed for audio over 30 s: run `npm install` inside voice/';
const TICK_PAD = 100000; // 10 ms per word, as in Microsoft's sample

export async function loadSpeechSdk(importer = () => import('microsoft-cognitiveservices-speech-sdk')) {
  let mod;
  try {
    mod = await importer();
  } catch (e) {
    throw new Error(e?.code === 'ERR_MODULE_NOT_FOUND' ? SDK_HINT : `${SDK_HINT} (${e?.message ?? e})`);
  }
  // The package is CommonJS: depending on the loader its API sits on the namespace or on default.
  return mod.SpeechConfig ? mod : (mod.default ?? mod);
}

// REST returns scores flat on NBest/word/phoneme; the SDK nests them under PronunciationAssessment.
const pick = (o, k) => o?.[k] ?? o?.PronunciationAssessment?.[k];

export function normalizeSegment(seg) {
  const best = seg?.NBest?.[0];
  if (!best) return { text: seg?.DisplayText ?? '', prosody: undefined, words: [] };
  const words = (best.Words ?? []).map((w) => ({
    Word: w.Word,
    Offset: w.Offset,
    Duration: w.Duration,
    AccuracyScore: pick(w, 'AccuracyScore'),
    ErrorType: pick(w, 'ErrorType') ?? 'None',
    Phonemes: (w.Phonemes ?? []).map((p) => ({ Phoneme: p.Phoneme, AccuracyScore: pick(p, 'AccuracyScore') })),
  }));
  return { text: seg.DisplayText ?? best.Display ?? '', prosody: pick(best, 'ProsodyScore'), words };
}

const keyOf = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');
const trimEdges = (s) => s.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

// Miscues over the whole merged answer (per-segment miscue against the full reference would be wrong):
// longest common subsequence of heard vs reference words; leftovers are Insertion / Omission.
function alignToReference(words, reference) {
  const ref = reference.split(/\s+/).map((t) => ({ display: trimEdges(t), key: keyOf(t) })).filter((t) => t.key);
  const n = words.length;
  const m = ref.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] = keyOf(words[i - 1].Word) === ref[j - 1].key ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const out = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && keyOf(words[i - 1].Word) === ref[j - 1].key && dp[i][j] === dp[i - 1][j - 1] + 1) {
      out.push(words[--i]);
      j--;
    } else if (i > 0 && (j === 0 || dp[i - 1][j] >= dp[i][j - 1])) {
      out.push({ ...words[--i], ErrorType: 'Insertion' });
    } else {
      out.push({ Word: ref[--j].display, ErrorType: 'Omission', AccuracyScore: 0, Phonemes: [] });
    }
  }
  return { words: out.reverse(), refCount: m };
}

const weighted = (values, weights) => [...values].sort((a, b) => a - b).reduce((sum, v, k) => sum + v * weights[k], 0);

// Overall scores follow Microsoft's continuous-assessment sample
// (cognitive-services-speech-sdk, scenarios/javascript/browser/language-learning).
export function mergeSegments(segments, { reference } = {}) {
  const segs = segments.map(normalizeSegment).filter((s) => s.words.length);
  if (!segs.length) return { RecognitionStatus: 'NoMatch' };
  let words = segs.flatMap((s) => s.words);
  let refCount = 0;
  if (reference) ({ words, refCount } = alignToReference(words, reference));

  const accWords = words.filter((w) => w.ErrorType !== 'Insertion');
  const accuracy = accWords.length ? mean(accWords.map((w) => (isNum(w.AccuracyScore) ? w.AccuracyScore : 0))) : 0;

  const prosodies = segs.map((s) => s.prosody).filter(isNum);
  const prosody = prosodies.length ? mean(prosodies) : undefined;

  const timed = words.filter((w) => isNum(w.Offset) && isNum(w.Duration));
  const span = timed.length ? Math.max(...timed.map((w) => w.Offset + w.Duration)) - timed[0].Offset : 0;
  const good = timed.filter((w) => w.ErrorType === 'None').reduce((sum, w) => sum + w.Duration + TICK_PAD, 0);
  const fluency = span > 0 ? Math.min(100, (good / span) * 100) : 0;

  const correct = words.filter((w) => w.ErrorType === 'None').length;
  const completeness = reference ? Math.min(100, refCount ? (correct / refCount) * 100 : 0) : 100;

  const hasP = prosody !== undefined;
  let pron;
  if (reference) pron = hasP ? weighted([accuracy, prosody, completeness, fluency], [0.4, 0.2, 0.2, 0.2]) : weighted([accuracy, completeness, fluency], [0.6, 0.2, 0.2]);
  else pron = hasP ? weighted([accuracy, prosody, fluency], [0.6, 0.2, 0.2]) : weighted([accuracy, fluency], [0.6, 0.4]);

  return {
    RecognitionStatus: 'Success',
    DisplayText: segs.map((s) => s.text).filter(Boolean).join(' '),
    NBest: [{
      AccuracyScore: round1(accuracy),
      FluencyScore: round1(fluency),
      ProsodyScore: hasP ? round1(prosody) : undefined,
      CompletenessScore: round1(completeness),
      PronScore: round1(pron),
      Words: words,
    }],
  };
}

// Runs one continuous recognition over a whole WAV and collects the JSON of every recognized segment.
export async function assessAudioContinuous({ wav, reference, locale = 'en-US', region, key, sdk }) {
  if (!isAllowedHost(`${region}.stt.speech.microsoft.com`, region)) throw new Error(`refusing to call disallowed host for region "${region}"`);
  return new Promise((resolve, reject) => {
    const segments = [];
    let reco;
    let done = false;
    const settle = (error) => {
      if (done) return;
      done = true;
      const close = () => { try { reco.close(); } catch { /* already closed */ } };
      reco.stopContinuousRecognitionAsync(
        () => { close(); if (error) reject(error); else resolve(segments); },
        (e) => { close(); reject(error ?? new Error(`Azure Speech stop failed: ${redact(e, key)}`)); },
      );
    };
    try {
      const speechConfig = sdk.SpeechConfig.fromSubscription(key, region);
      speechConfig.speechRecognitionLanguage = locale;
      const audioConfig = sdk.AudioConfig.fromWavFileInput(wav);
      // Miscue is off on purpose: it is computed over the merged answer, not per segment.
      const pa = sdk.PronunciationAssessmentConfig.fromJSON(JSON.stringify({
        referenceText: reference ?? '', gradingSystem: 'HundredMark', granularity: 'Phoneme', phonemeAlphabet: 'IPA', enableMiscue: false,
      }));
      pa.enableProsodyAssessment();
      reco = new sdk.SpeechRecognizer(speechConfig, audioConfig);
      pa.applyTo(reco);
      reco.recognized = (_s, e) => {
        if (e.result.reason !== sdk.ResultReason.RecognizedSpeech) return; // NoMatch: skip the segment
        try {
          segments.push(JSON.parse(e.result.properties.getProperty(sdk.PropertyId.SpeechServiceResponse_JsonResult)));
        } catch { /* an unreadable segment is dropped; no words means NoMatch later */ }
      };
      reco.canceled = (_s, e) => {
        if (e.reason === sdk.CancellationReason.Error) settle(new Error(`Azure Speech recognition failed: ${redact(e.errorDetails, key)}`));
        else settle(); // EndOfStream is the normal end of a file
      };
      reco.sessionStopped = () => settle();
      reco.startContinuousRecognitionAsync(undefined, (e) => settle(new Error(`Azure Speech could not start: ${redact(e, key)}`)));
    } catch (e) {
      done = true;
      try { reco?.close(); } catch { /* ignore */ }
      reject(new Error(`Azure Speech SDK setup failed: ${redact(e?.message ?? e, key)}`));
    }
  });
}
