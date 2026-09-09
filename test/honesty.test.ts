// The wrapper must report the run honestly: pass the command's exit code through, never re-run a
// red command unlocked, and say loudly when a run proceeds without the lock.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { exists, heldElsewhere, runWrapper, sleep, tempLock } from './support/wrapper.js';

const t = tempLock();

describe('the wrapper reports the run honestly', () => {
  it('passes the command exit code through', async () => {
    // A wrapper that swallowed this would turn every red run green.
    expect(await runWrapper(t.lock, [process.execPath, '-e', 'process.exit(3)']).code).toBe(3);
  }, 20_000);

  it('reports a command killed by a signal as 128+signal, not a utility code', async () => {
    // `lockf` maps a signal-killed child to EX_SOFTWARE (70), losing WHICH signal on exactly the
    // OOM/segfault runs that need it — the inner sh stays the command's parent (no exec) so the
    // mapping is sh's own 128+n, identical to the unlocked path and to Linux.
    const run = runWrapper(t.lock, [
      process.execPath,
      '-e',
      'process.kill(process.pid, "SIGKILL")',
    ]);
    expect(await run.code).toBe(137);
    expect(await run.stderr).not.toContain('WITHOUT the lock');
  }, 20_000);

  it('a FAILING command runs exactly once and is never re-run unlocked', async () => {
    // The sentinel exists to separate "the command ran and failed" from "the locking utility
    // failed", and the expensive way to get that wrong is to read every red run as a utility
    // failure: the whole command would then run a SECOND time, unlocked, and still report the same
    // exit code — so the mistake is invisible in the verdict and shows up only as a machine
    // burning twice the CPU for a gate that already knew its answer. Asserting the code alone
    // cannot see it.
    const counter = path.join(t.dir, 'runs');
    const run = runWrapper(t.lock, [
      process.execPath,
      '-e',
      `require('node:fs').appendFileSync(${JSON.stringify(counter)}, 'x'); process.exit(9)`,
    ]);
    expect(await run.code).toBe(9);
    expect(await fs.readFile(counter, 'utf8')).toBe('x');
    expect(await run.stderr).not.toContain('WITHOUT the lock');
  }, 20_000);

  it('runs unlocked, loudly, when no locking utility exists', async () => {
    // The override is what the test can actually manipulate: the utility is resolved to an
    // absolute path, so editing PATH would not disable it and this test would be red on macOS
    // forever.
    const run = runWrapper(t.lock, [process.execPath, '-e', 'process.exit(4)'], {
      CPU_MUTEX_BIN: '/nonexistent',
    });
    expect(await run.code).toBe(4);
    // The stderr line is the discriminating half: exiting 4 alone would also happen if the lock
    // had been taken normally, so silence here would leave the degradation unobserved.
    expect(await run.stderr).toContain('WITHOUT the lock');
  }, 20_000);

  it('runs unlocked, loudly, when the wait ceiling runs out', async () => {
    const held = await heldElsewhere(t.dir, t.lock);
    const run = runWrapper(t.lock, [process.execPath, '-e', 'process.exit(5)'], {
      CPU_MUTEX_WAIT_S: '1',
    });
    expect(await run.code).toBe(5);
    const stderr = await run.stderr;
    expect(stderr).toContain('could not acquire the lock');
    expect(stderr).toContain('WITHOUT the lock');
    // …while the holder demonstrably still held: otherwise this would be an ordinary handover.
    expect(held.stillHolding()).toBe(true);
    held.release();
    expect(await held.stderr).not.toContain('WITHOUT the lock');
  }, 30_000);

  // The same guard on both paths, deliberately: the unlocked ones (CI, CPU_MUTEX=0, no utility,
  // unusable lock file) are where an orphaned run is the DEFAULT outcome rather than the
  // exception, so the group treatment has to hold there as well — otherwise the guard exists
  // exactly where it is least needed. On the locked path the kernel frees the lock the moment the
  // holder dies (measured on `lockf`: a killed holder leaves its command running with the lock
  // already released — a full run burning every core outside the mutex).
  for (const [label, env] of [
    ['locked', {}],
    ['unlocked', { CPU_MUTEX_BIN: '/nonexistent' }],
  ] as const) {
    it(`kills the run when signalled on the ${label} path`, async () => {
      const marker = path.join(t.dir, `survived-${label}`);
      const run = runWrapper(
        t.lock,
        [
          process.execPath,
          '-e',
          `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, ''), 5000)`,
        ],
        env,
      );
      await sleep(1_500);
      process.kill(run.pid as number, 'SIGTERM');
      await run.code;
      await sleep(5_000);
      expect(await exists(marker)).toBe(false);
    }, 30_000);
  }
});
