import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { detectPlayer, play } from '../voice/lib/player.mjs';
import { appendUsage, monthUsage, monthSeconds, budgetStatus } from '../voice/lib/usage.mjs';
import { cacheKey, getCached, putCached } from '../voice/lib/cache.mjs';

const WAV = 'C:\\Users\\a b\\x\'; Remove-Item *; $(evil).wav';

test('win32 player passes the path through the environment, never in the command text', () => {
  const p = detectPlayer('win32', 'auto');
  assert.equal(p.cmd, 'powershell.exe');
  const args = p.args(WAV);
  assert.deepEqual(args.slice(0, 2), ['-NoProfile', '-Command']);
  assert.ok(!args.join(' ').includes(WAV), 'path must not be interpolated into args');
  assert.ok(!args.join(' ').includes('Remove-Item'));
  assert.deepEqual(Object.values(p.env(WAV)), [WAV]);
});

test('darwin and linux players take the wav as a plain argument', () => {
  assert.deepEqual([detectPlayer('darwin', 'auto').cmd, detectPlayer('darwin', 'auto').args('/t/a.wav')], ['afplay', ['/t/a.wav']]);
  const l = detectPlayer('linux', 'auto', { has: (c) => c === 'paplay' });
  assert.equal(l.cmd, 'paplay');
  assert.deepEqual(l.args('/t/a.wav'), ['/t/a.wav']);
  assert.equal(detectPlayer('linux', 'auto', { has: () => false }).cmd, 'aplay');
});

test('player setting overrides the platform default', () => {
  assert.equal(detectPlayer('win32', 'ffplay').cmd, 'ffplay');
  assert.deepEqual(detectPlayer('win32', 'ffplay').args('/t/a.wav'), ['-nodisp', '-autoexit', '/t/a.wav']);
  assert.equal(detectPlayer('linux', 'powershell').cmd, 'powershell.exe');
  assert.equal(detectPlayer('darwin', 'aplay').cmd, 'aplay');
});

function fakeSpawn(code, calls) {
  return (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const ee = new EventEmitter();
    setImmediate(() => ee.emit('close', code));
    return ee;
  };
}

test('play resolves on exit code 0 and rejects otherwise', async () => {
  const calls = [];
  await play('/t/a.wav', { player: detectPlayer('darwin', 'auto'), spawnImpl: fakeSpawn(0, calls) });
  assert.equal(calls[0].cmd, 'afplay');
  assert.deepEqual(calls[0].args, ['/t/a.wav']);
  await assert.rejects(play('/t/a.wav', { player: detectPlayer('darwin', 'auto'), spawnImpl: fakeSpawn(1, []) }), /exited with code 1/);
});

test('play puts the wav path in the child environment on win32', async () => {
  const calls = [];
  await play(WAV, { player: detectPlayer('win32', 'auto'), spawnImpl: fakeSpawn(0, calls) });
  assert.ok(Object.values(calls[0].opts.env).includes(WAV));
});

function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'voice-usage-'));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('usage appends TSV rows with a header and sums chars per month', () => {
  withRoot((root) => {
    appendUsage({ root, date: '2026-10-30', operation: 'say', chars: 100 });
    appendUsage({ root, date: '2026-10-31', operation: 'read', chars: 250 });
    appendUsage({ root, date: '2026-11-01', operation: 'say', chars: 999 });
    appendUsage({ root, date: '2026-10-31', operation: 'assess', seconds: 12 });
    const lines = readFileSync(join(root, 'data', 'voice-usage.tsv'), 'utf8').trim().split('\n');
    assert.equal(lines[0], 'date\toperation\tchars\tseconds');
    assert.equal(lines.length, 5);
    assert.equal(monthUsage(root, '202610'), 350);
    assert.equal(monthUsage(root, '202611'), 999);
    assert.equal(monthUsage(root, '202601'), 0);
  });
});

test('monthSeconds sums the seconds column for one month and ignores chars rows', () => {
  withRoot((root) => {
    assert.equal(monthSeconds(root, '202611'), 0);
    appendUsage({ root, date: '2026-11-01', operation: 'assess', seconds: 12.3 });
    appendUsage({ root, date: '2026-11-20', operation: 'assess', seconds: 45 });
    appendUsage({ root, date: '2026-11-21', operation: 'say', chars: 500 });
    appendUsage({ root, date: '2026-10-31', operation: 'assess', seconds: 99 });
    assert.equal(monthSeconds(root, '202611'), 57.3);
    assert.equal(monthSeconds(root, '202610'), 99);
    assert.equal(monthUsage(root, '202611'), 500);
  });
});

test('budgetStatus warns at 90 percent', () => {
  assert.deepEqual(budgetStatus(100, 1000), { ok: true, warn90: false });
  assert.deepEqual(budgetStatus(900, 1000), { ok: true, warn90: true });
  assert.deepEqual(budgetStatus(1000, 1000), { ok: false, warn90: true });
});

test('cacheKey is stable and sensitive to every field', () => {
  const base = ['hello', 'en-US-JennyNeural', 'friendly', 1, '-5%', 'default'];
  assert.equal(cacheKey(...base), cacheKey(...base));
  assert.match(cacheKey(...base), /^[0-9a-f]{64}$/);
  for (let i = 0; i < base.length; i++) {
    const other = [...base];
    other[i] = i === 3 ? 1.5 : `${base[i]}x`;
    assert.notEqual(cacheKey(...other), cacheKey(...base), `field ${i}`);
  }
  assert.notEqual(cacheKey('a', 'bc', null, 1, '0%', 'default'), cacheKey('ab', 'c', null, 1, '0%', 'default'));
});

test('cache stores and returns wav bytes', () => {
  withRoot((root) => {
    assert.equal(getCached(root, 'abc'), null);
    const path = putCached(root, 'abc', Buffer.from('RIFFdata'));
    assert.equal(path, join(root, 'output', 'voice', 'cache', 'abc.wav'));
    assert.equal(getCached(root, 'abc'), path);
  });
});
