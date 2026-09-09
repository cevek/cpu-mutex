// `--status` answers "who holds the mutex" from the KERNEL (the same non-blocking probe the
// waiting notice uses), with the advisory sidecar only ever shown next to a verdict it agrees
// with. Exit codes are the scriptable surface: 0 free, 1 held, 3 undeterminable.

import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { exists, heldElsewhere, runWrapper, sleep, tempLock } from './support/wrapper.js';

const t = tempLock();

describe('cpu-mutex --status', () => {
  it('a missing lock file is free, and status does not create it', async () => {
    const run = runWrapper(t.lock, [], { CPU_MUTEX_FILE: undefined, CPU_MUTEX_DIR: t.dir }, [
      '--status',
      '--name',
      'idle',
    ]);
    expect(await run.code).toBe(0);
    expect(await run.stdout).toContain(`${path.join(t.dir, 'idle.lock')}: free`);
    // A status query that creates the file would turn every dashboard poll into a write.
    expect(await exists(path.join(t.dir, 'idle.lock'))).toBe(false);
  }, 20_000);

  it('a held lock reports the holder and exits 1; released, it reports free', async () => {
    const held = await heldElsewhere(t.dir, t.lock);
    // The sidecar is written by the holder's 250ms watcher; wait for it so the assertion is about
    // content, not the race.
    while (!(await exists(`${t.lock}.info`))) await sleep(25);

    const busy = runWrapper(t.lock, [], {}, ['--status']);
    expect(await busy.code).toBe(1);
    const stdout = await busy.stdout;
    expect(stdout).toContain('held by pid');
    expect(stdout).toContain(t.lock);

    held.release();
    // The holder's kernel lock dies with it; poll until the probe agrees.
    for (;;) {
      const free = runWrapper(t.lock, [], {}, ['--status']);
      if ((await free.code) === 0) {
        expect(await free.stdout).toContain('free');
        break;
      }
      await sleep(50);
    }
  }, 30_000);

  it('with no locking utility it says it cannot tell and exits 3', async () => {
    // A normal run creates the lock file first: while the file is missing, "free" is the honest
    // answer even without a utility, so the cannot-tell verdict needs an existing file.
    await runWrapper(t.lock, [process.execPath, '-e', 'process.exit(0)']).code;
    const run = runWrapper(t.lock, [], { CPU_MUTEX_BIN: '/nonexistent' }, ['--status']);
    expect(await run.code).toBe(3);
    expect(await run.stdout).toContain('cannot tell');
  }, 20_000);

  it('--status with a command is a usage error', async () => {
    const run = runWrapper(t.lock, [process.execPath, '-e', 'process.exit(0)'], {}, ['--status']);
    expect(await run.code).toBe(2);
    expect(await run.stderr).toContain('--status takes no command');
  }, 20_000);
});
