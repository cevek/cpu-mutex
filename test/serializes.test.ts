// The load-bearing claim is that the lock BLOCKS — a test that takes and releases it once stays
// green over a lock that never blocks anyone. So two runs start together (through a shared gate
// file, never by relying on spawn speed: under the load this exists for, spawn skew alone would
// separate them and the negative control would pass for the wrong reason) and the assertion is
// that their intervals do not overlap. Which of the two wins is NOT asserted — that is a genuine
// tie.

import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { exists, overlaps, raceTwo, runWrapper, tempLock } from './support/wrapper.js';

const t = tempLock();

describe('the lock serializes concurrent runs', () => {
  it('two runs started together do not overlap in time', async () => {
    const [a, b] = await raceTwo(t.dir, t.lock);
    expect(a && b && overlaps(a, b)).toBe(false);
  }, 40_000);

  it('without the lock the same two runs DO overlap (the fixture can observe concurrency)', async () => {
    const [a, b] = await raceTwo(t.dir, t.lock, { CPU_MUTEX: '0' });
    expect(a && b && overlaps(a, b)).toBe(true);
  }, 40_000);

  it('runs under different lock files do not contend', async () => {
    const [a, b] = await raceTwo(
      t.dir,
      t.lock,
      {},
      {
        a: { CPU_MUTEX_FILE: path.join(t.dir, 'a.lock') },
        b: { CPU_MUTEX_FILE: path.join(t.dir, 'b.lock') },
      },
    );
    expect(a && b && overlaps(a, b)).toBe(true);
  }, 40_000);
});

describe('lock file derivation', () => {
  it('--name under CPU_MUTEX_DIR derives <dir>/<name>.lock', async () => {
    const run = runWrapper(
      t.lock,
      [process.execPath, '-e', 'process.exit(0)'],
      { CPU_MUTEX_FILE: undefined, CPU_MUTEX_DIR: t.dir },
      ['--name', 'heavy'],
    );
    expect(await run.code).toBe(0);
    expect(await exists(path.join(t.dir, 'heavy.lock'))).toBe(true);
  }, 20_000);

  it('the default lock name is "default"', async () => {
    const run = runWrapper(t.lock, [process.execPath, '-e', 'process.exit(0)'], {
      CPU_MUTEX_FILE: undefined,
      CPU_MUTEX_DIR: t.dir,
    });
    expect(await run.code).toBe(0);
    expect(await exists(path.join(t.dir, 'default.lock'))).toBe(true);
  }, 20_000);
});
