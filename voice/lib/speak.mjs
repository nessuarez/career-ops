// Shared synthesis path for say/read: cache lookup, styles, Azure call, usage ledger.
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { buildSsml, synthesize, listVoices, stylesForVoice } from './azure-tts.mjs';
import { appendUsage, monthUsage, budgetStatus } from './usage.mjs';
import { cacheKey, getCached, putCached } from './cache.mjs';

// Picks the persona settings; an unknown name says which file defines personas.
export function resolvePersona(cfg, name, root, { fallback } = {}) {
  const defined = Object.keys(cfg.settings.personas);
  if (name && !defined.includes(name)) {
    const file = join(root, 'config', 'voice.yml');
    const hint = existsSync(file) ? `add it under voice.personas in ${file}` : `create ${file} (copy voice/voice.example.yml) with voice.personas.${name}`;
    throw new Error(`unknown persona "${name}" (defined: ${defined.join(', ') || 'none'}); ${hint}`);
  }
  return cfg.persona(name ?? (fallback && defined.includes(fallback) ? fallback : undefined));
}

export function createSpeaker({ root, cfg, deps, stderr }) {
  const now = deps.now ?? (() => Date.now());
  const fetchImpl = deps.fetchImpl ?? fetch;
  const warned = new Set();
  let styleSource; // memoized: { voices } | { error }

  const warnOnce = (msg) => {
    if (warned.has(msg)) return;
    warned.add(msg);
    stderr(`voice: ${msg}\n`);
  };

  async function stylesFor(voice) {
    if (!styleSource) {
      try {
        styleSource = { voices: await listVoices({ region: cfg.azure.region, key: cfg.azure.key, cacheDir: join(root, 'output', 'voice'), now: now(), fetchImpl }) };
      } catch (e) {
        styleSource = { error: e.message };
      }
    }
    if (styleSource.error) {
      warnOnce(`could not read the style list (${styleSource.error}); speaking without a style`);
      return [];
    }
    return stylesForVoice(styleSource.voices, voice);
  }

  return {
    // Returns { wav, cached }. Usage is recorded only for real synthesis.
    async wavFor(text, s, operation) {
      const key = cacheKey(text, s.voice, s.style, s.style_degree, s.rate, s.pitch);
      const hit = s.cache ? getCached(root, key) : null;
      if (hit) return { wav: hit, cached: true };
      const supportedStyles = s.style != null ? await stylesFor(s.voice) : [];
      const { ssml, warnings } = buildSsml({ text, locale: s.locale, voice: s.voice, style: s.style, styleDegree: s.style_degree, rate: s.rate, pitch: s.pitch, supportedStyles });
      warnings.forEach(warnOnce);
      const audio = await synthesize({ ssml, region: cfg.azure.region, key: cfg.azure.key, fetchImpl, sleep: deps.retrySleep });
      const wav = putCached(root, key, audio);
      appendUsage({ root, date: new Date(now()).toISOString().slice(0, 10), operation, chars: text.length });
      return { wav, cached: false };
    },
    budgetWarn(s) {
      const month = new Date(now()).toISOString().slice(0, 7);
      const used = monthUsage(root, month.replace('-', ''));
      if (budgetStatus(used, s.monthly_char_budget).warn90) stderr(`voice: ${used} of ${s.monthly_char_budget} monthly characters used (over 90%)\n`);
    },
  };
}
