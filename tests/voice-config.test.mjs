import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadVoiceConfig, isAllowedHost } from '../voice/lib/config.mjs';

const FAKE_KEY = 'fake-key-0123456789abcdef';
const ENV_VARS = ['AZURE_SPEECH_KEY', 'AZURE_SPEECH_REGION'];
const ENV_OK = `AZURE_SPEECH_KEY=${FAKE_KEY}\nAZURE_SPEECH_REGION=northeurope\n`;

// Temp root with optional config/voice.yml and .env; env vars are saved/restored.
function withRoot({ yml, env } = {}, fn) {
  const root = mkdtempSync(join(tmpdir(), 'voice-cfg-'));
  const saved = Object.fromEntries(ENV_VARS.map((k) => [k, process.env[k]]));
  ENV_VARS.forEach((k) => delete process.env[k]);
  try {
    if (yml !== undefined) {
      mkdirSync(join(root, 'config'));
      writeFileSync(join(root, 'config', 'voice.yml'), yml);
    }
    if (env !== undefined) writeFileSync(join(root, '.env'), env);
    return fn(root);
  } finally {
    for (const k of ENV_VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(root, { recursive: true, force: true });
  }
}

test('defaults apply when config/voice.yml is absent', () => {
  withRoot({ env: ENV_OK }, (root) => {
    const c = loadVoiceConfig({ root });
    assert.equal(c.settings.locale, 'en-US');
    assert.equal(c.settings.voice, 'en-US-JennyNeural');
    assert.equal(c.settings.rate, '-5%');
    assert.equal(c.settings.monthly_char_budget, 450000);
    assert.equal(c.settings.player, 'auto');
    assert.deepEqual(
      { region: c.azure.region, host: c.azure.host },
      { region: 'northeurope', host: 'northeurope.tts.speech.microsoft.com' },
    );
  });
});

test('user yml overrides defaults and keeps the rest', () => {
  withRoot({ env: ENV_OK, yml: 'voice:\n  voice: en-US-GuyNeural\n  show_text: false\n' }, (root) => {
    const { settings } = loadVoiceConfig({ root });
    assert.equal(settings.voice, 'en-US-GuyNeural');
    assert.equal(settings.show_text, false);
    assert.equal(settings.style, 'friendly');
  });
});

test('persona overlays base settings; unknown persona returns base', () => {
  const yml = 'voice:\n  personas:\n    panel: { voice: en-GB-RyanNeural, style: null, rate: "0%" }\n';
  withRoot({ env: ENV_OK, yml }, (root) => {
    const c = loadVoiceConfig({ root });
    const p = c.persona('panel');
    assert.equal(p.voice, 'en-GB-RyanNeural');
    assert.equal(p.style, null);
    assert.equal(p.rate, '0%');
    assert.equal(p.locale, 'en-US');
    assert.equal(c.persona('nobody').voice, c.settings.voice);
    assert.equal(c.persona().voice, c.settings.voice);
  });
});

test('invalid values are rejected', () => {
  const bad = [
    'enabled: "yes"', 'locale: english', 'rate: fast', 'pitch: high',
    'style_degree: 5', 'style_degree: 0', 'player: vlc',
    'monthly_char_budget: -1', 'monthly_char_budget: 1.5', 'personas: [a]',
    'personas: { x: { rate: nope } }',
  ];
  for (const line of bad) {
    withRoot({ env: ENV_OK, yml: `voice:\n  ${line}\n` }, (root) => {
      assert.throws(() => loadVoiceConfig({ root }), /voice/i, line);
    });
  }
});

test('missing key or region throws naming the variable', () => {
  withRoot({ env: 'AZURE_SPEECH_REGION=northeurope\n' }, (root) => {
    assert.throws(() => loadVoiceConfig({ root }), /AZURE_SPEECH_KEY/);
  });
  withRoot({ env: `AZURE_SPEECH_KEY=${FAKE_KEY}\n` }, (root) => {
    assert.throws(() => loadVoiceConfig({ root }), /AZURE_SPEECH_REGION/);
  });
});

test('invalid region is rejected without leaking the key', () => {
  withRoot({ env: `AZURE_SPEECH_KEY=${FAKE_KEY}\nAZURE_SPEECH_REGION=evil.com/x\n` }, (root) => {
    assert.throws(() => loadVoiceConfig({ root }), (e) => {
      assert.match(e.message, /AZURE_SPEECH_REGION/);
      assert.ok(!e.message.includes(FAKE_KEY));
      return true;
    });
  });
});

test('key never appears in errors or serialized config', () => {
  withRoot({ env: ENV_OK, yml: 'voice:\n  rate: bad\n' }, (root) => {
    assert.throws(() => loadVoiceConfig({ root }), (e) => !String(e.stack).includes(FAKE_KEY));
  });
  withRoot({ env: ENV_OK }, (root) => {
    const c = loadVoiceConfig({ root });
    assert.ok(!JSON.stringify(c).includes(FAKE_KEY));
    assert.ok(!JSON.stringify(c.azure).includes(FAKE_KEY));
    assert.equal(c.azure.key, FAKE_KEY); // available to the client on demand only
  });
});

test('process.env wins over .env and is not mutated by loading', () => {
  withRoot({ env: ENV_OK }, (root) => {
    process.env.AZURE_SPEECH_REGION = 'westeurope';
    let c = loadVoiceConfig({ root });
    assert.equal(c.azure.region, 'westeurope');
    delete process.env.AZURE_SPEECH_REGION;
    c = loadVoiceConfig({ root });
    assert.equal(c.azure.region, 'northeurope');
    assert.equal(process.env.AZURE_SPEECH_KEY, undefined);
  });
});

test('.env parser handles quotes, comments and blank lines', () => {
  const env = `# comment\n\nAZURE_SPEECH_KEY="${FAKE_KEY}"\nexport AZURE_SPEECH_REGION='northeurope'\n`;
  withRoot({ env }, (root) => {
    const c = loadVoiceConfig({ root });
    assert.equal(c.azure.key, FAKE_KEY);
    assert.equal(c.azure.region, 'northeurope');
  });
});

test('host guard allows only the regional TTS host', () => {
  assert.equal(isAllowedHost('northeurope.tts.speech.microsoft.com', 'northeurope'), true);
  assert.equal(isAllowedHost('westeurope.tts.speech.microsoft.com', 'northeurope'), false);
  assert.equal(isAllowedHost('evil.com', 'northeurope'), false);
  assert.equal(isAllowedHost('northeurope.tts.speech.microsoft.com.evil.com', 'northeurope'), false);
  assert.equal(isAllowedHost('', 'northeurope'), false);
});
