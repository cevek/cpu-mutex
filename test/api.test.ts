// Programmatic-API misuse must fail with a TypeError BEFORE anything is spawned or touched on
// disk — unlike env junk, which degrades loudly to a default. Every rejection here happens in
// validation, so no lock file is involved.

import { describe, expect, it } from 'vitest';
import { lockFilePath, runLocked } from '../src/index.js';

describe('runLocked validates its options', () => {
  it('rejects an empty command', async () => {
    await expect(runLocked([])).rejects.toThrow(TypeError);
  });

  for (const waitS of [2.5, 0, -5, 1e21, 2147483648]) {
    it(`rejects waitS=${waitS}`, async () => {
      // 1e21 is the token trap: `Number.isInteger(1e21)` is true while `String(1e21)` is '1e+21',
      // a token the utility rejects — which would read as "could not acquire" and run unlocked.
      // 2^31 is past the utilities' numeric range, same outcome via a usage error.
      await expect(runLocked(['true'], { waitS })).rejects.toThrow(TypeError);
    });
  }

  it('rejects a lock name that would escape the state dir', async () => {
    await expect(runLocked(['true'], { name: '../escape', env: {} })).rejects.toThrow(TypeError);
  });
});

describe('lockFilePath owns the name invariant', () => {
  it('throws on an invalid name even when CPU_MUTEX_FILE would override it', () => {
    expect(() => lockFilePath('../escape', { CPU_MUTEX_FILE: '/tmp/x' })).toThrow(TypeError);
  });

  it('CPU_MUTEX_FILE overrides the derivation', () => {
    expect(lockFilePath('any', { CPU_MUTEX_FILE: '/tmp/explicit.lock' })).toBe(
      '/tmp/explicit.lock',
    );
  });

  it('derives <CPU_MUTEX_DIR>/<name>.lock', () => {
    expect(lockFilePath('heavy', { CPU_MUTEX_DIR: '/tmp/d' })).toBe('/tmp/d/heavy.lock');
  });
});
