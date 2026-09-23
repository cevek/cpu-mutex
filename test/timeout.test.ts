// `--timeout` bounds how long a holder may RUN. The hazard it must not create: the lock utility dies
// on SIGTERM at once and frees the lock, so a wrapper that reported the timeout at that point would
// leave a SIGTERM-ignoring command burning every core outside the mutex. Every kill assertion here
// is therefore about the COMMAND's pid, read the moment the wrapper exits — "the lock is free"
// would be green for that exact bug.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runLocked } from '../src/index.js';
import { exists, heldElsewhere, runWrapper, sleep, tempLock } from './support/wrapper.js';

const t = tempLock();

// A red run here means a SIGTERM-ignoring fixture survived; it must not outlive the test.
const spawned: number[] = [];
afterEach(() => {
  for (const pid of spawned.splice(0)) {
    if (!alive(pid)) continue;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const readPid = async (file: string): Promise<number> => {
  // Existence is not content: an empty read would be pid 0, and kill(0) signals our own group.
  for (;;) {
    const pid = (await exists(file)) ? Number(await fs.readFile(file, 'utf8')) : 0;
    if (Number.isInteger(pid) && pid > 0) {
      spawned.push(pid);
      return pid;
    }
    await sleep(25);
  }
};

// Writes its pid, then sits until killed; `ignoreTerm` models the wedged process the ceiling is for.
const sitter = (pidFile: string, ignoreTerm: boolean): string[] => [
  process.execPath,
  '-e',
  `${ignoreTerm ? "process.on('SIGTERM', () => {});" : ''}` +
    `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));` +
    'setInterval(() => {}, 1000);',
];

describe('--timeout bounds the run', () => {
  for (const [label, env] of [
    ['locked', {}],
    ['unlocked', { CPU_MUTEX_BIN: '/nonexistent' }],
  ] as const) {
    it(`escalates to SIGKILL for a command ignoring SIGTERM (${label} path)`, async () => {
      const pidFile = path.join(t.dir, 'pid');
      const run = runWrapper(t.lock, sitter(pidFile, true), env, ['--timeout', '1']);
      const pid = await readPid(pidFile);
      expect(await run.code).toBe(137);
      expect(alive(pid)).toBe(false);
      const stderr = await run.stderr;
      expect(stderr).toContain('exceeded the run ceiling (--timeout 1s)');
      expect(stderr).toContain('SIGKILL');
    }, 30_000);
  }

  it('exits 124 when SIGTERM suffices, and the lock is free afterwards', async () => {
    const pidFile = path.join(t.dir, 'pid');
    const run = runWrapper(t.lock, sitter(pidFile, false), {}, ['--timeout', '1']);
    const pid = await readPid(pidFile);
    expect(await run.code).toBe(124);
    expect(alive(pid)).toBe(false);
    const stderr = await run.stderr;
    expect(stderr).toContain('exceeded the run ceiling (--timeout 1s)');
    expect(stderr).not.toContain('SIGKILL');
    expect(stderr).not.toContain('WITHOUT the lock');
    expect(await runWrapper(t.lock, [], {}, ['--status']).code).toBe(0);
  }, 30_000);

  it('does not count time spent waiting for the lock', async () => {
    const held = await heldElsewhere(t.dir, t.lock);
    const run = runWrapper(
      t.lock,
      [process.execPath, '-e', 'setTimeout(() => process.exit(7), 1500)'],
      {},
      ['--timeout', '2'],
    );
    // Queued past its whole budget before it gets to run at all.
    await sleep(3_000);
    held.release();
    expect(await run.code).toBe(7);
    const stderr = await run.stderr;
    expect(stderr).toContain('waiting for the lock');
    expect(stderr).not.toContain('exceeded');
  }, 30_000);

  it("passes a fast command's own exit code through", async () => {
    const run = runWrapper(t.lock, [process.execPath, '-e', 'process.exit(3)'], {}, [
      '--timeout',
      '30',
    ]);
    expect(await run.code).toBe(3);
    expect(await run.stderr).not.toContain('exceeded');
  }, 20_000);

  it("a queued in-process call does not run on its neighbour's clock", async () => {
    // Concurrent runLocked calls in one process: the queued one must neither start its clock on
    // the holder's start nor count the holder's run as its own.
    // Each command runs 2 s under a 3 s ceiling, so only a clock started by the OTHER call's run
    // (queued 2 s + own 2 s) can expire.
    const env = { CPU_MUTEX: '1', PATH: process.env['PATH'] };
    const call = (code: number): Promise<number> =>
      runLocked([process.execPath, '-e', `setTimeout(() => process.exit(${code}), 2000)`], {
        file: t.lock,
        env,
        timeoutS: 3,
      });
    expect(await Promise.all([call(3), call(5)])).toEqual([3, 5]);
  }, 30_000);

  for (const bad of ['0', '-1', '2.5', '2147484', 'x']) {
    it(`rejects --timeout ${bad} as a usage error`, async () => {
      expect(await runWrapper(t.lock, ['true'], {}, ['--timeout', bad]).code).toBe(2);
    }, 20_000);
  }

  it('--status takes no --timeout', async () => {
    expect(await runWrapper(t.lock, [], {}, ['--status', '--timeout', '5']).code).toBe(2);
  }, 20_000);
});
