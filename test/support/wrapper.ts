// Shared fixtures for driving the real CLI as a subprocess: the lock lives in process startup, a
// kernel file lock and signal handling, so an in-process call would exercise none of it.
//
// Every test points CPU_MUTEX_FILE (or CPU_MUTEX_DIR) at its own temp dir, and the inherited
// environment is stripped of CPU_MUTEX_* / CI first. None may touch the real machine-wide lock: a
// test that did would serialize against live runs on this machine.

import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect } from 'vitest';

export const SCRIPT = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));

// Generous on purpose: the negative control needs the second holder to START inside this window,
// and under real load a node spawn is not a millisecond affair. A short hold would make a slow
// machine look like a broken lock.
export const HOLD_MS = 2_500;

export type Env = Record<string, string | undefined>;

/** A per-test temp dir and lock file inside it; registers the vitest hooks. Read the fields inside
 * tests only — they are (re)assigned by beforeEach. */
export const tempLock = (): { dir: string; lock: string } => {
  const state = { dir: '', lock: '' };
  beforeEach(async () => {
    state.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cpu-mutex-'));
    state.lock = path.join(state.dir, 'suite.lock');
  });
  afterEach(async () => {
    await fs.rm(state.dir, { recursive: true, force: true });
  });
  return state;
};

export const testEnv = (lock: string, env: Env): Env => {
  const clean: Env = { ...process.env };
  for (const key of Object.keys(clean)) {
    if (key.startsWith('CPU_MUTEX') || key === 'CI') delete clean[key];
  }
  return { ...clean, CPU_MUTEX: '1', CPU_MUTEX_FILE: lock, ...env };
};

export const exists = (file: string): Promise<boolean> =>
  fs.access(file).then(
    () => true,
    () => false,
  );

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export type Run = { code: Promise<number>; stderr: Promise<string>; pid: number | undefined };

export const runWrapper = (
  lock: string,
  argv: string[],
  env: Env = {},
  wrapperArgs: string[] = [],
): Run => {
  const child = spawn(process.execPath, [SCRIPT, ...wrapperArgs, '--', ...argv], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: testEnv(lock, env),
  });
  let text = '';
  child.stderr.on('data', (chunk: Buffer) => (text += chunk.toString()));
  return {
    pid: child.pid,
    code: new Promise<number>((resolve) => child.on('close', (c) => resolve(c ?? 1))),
    stderr: new Promise<string>((resolve) => child.on('close', () => resolve(text))),
  };
};

/** Waits for the gate, then takes the lock and records the interval it held it for. Split into its
 * own process because the gate wait must happen BEFORE the lock is taken, so it cannot live in the
 * command the wrapper runs. */
const starterSource = (holder: string): string => `
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
const [gate, log, id, hold] = process.argv.slice(2);
fs.writeFileSync(gate + '.ready.' + id, '');
while (!fs.existsSync(gate)) {}
const child = spawn(process.execPath, [
  ${JSON.stringify(SCRIPT)}, '--',
  process.execPath, ${JSON.stringify(holder)}, log, id, hold,
], { stdio: 'inherit' });
child.on('close', (code) => process.exit(code ?? 1));
`;

// Holds until it SEES the other holder start, or until the deadline — which is what makes the
// negative control immune to start skew: unlocked, each side stays inside its critical section
// until the other is demonstrably in its own, so they overlap at any spawn delay. Locked, the
// other side never starts and this one falls through on its deadline. The floor matters as much
// as the ceiling: the other's start line may already be there on the first look, and a
// zero-length interval overlaps nothing, so without it the negative control would report
// serialization that never happened.
const holderSource = `
import * as fs from 'node:fs';
const [log, id, hold] = process.argv.slice(2);
const began = Date.now();
fs.appendFileSync(log, 'start ' + id + ' ' + began + '\\n');
const until = began + Number(hold);
const floor = began + 100;
const sawOther = () => fs.readFileSync(log, 'utf8').split('\\n')
  .some((l) => l.startsWith('start ') && l.split(' ')[1] !== id);
while (Date.now() < until && (Date.now() < floor || !sawOther())) {}
fs.appendFileSync(log, 'end ' + id + ' ' + Date.now() + '\\n');
`;

export type Interval = { id: string; start: number; end: number };

const parseLog = (text: string): Interval[] => {
  const starts = new Map<string, number>();
  const out: Interval[] = [];
  for (const line of text.split('\n')) {
    const [kind, id, at] = line.trim().split(' ');
    if (id === undefined || at === undefined) continue;
    if (kind === 'start') starts.set(id, Number(at));
    if (kind === 'end') {
      const start = starts.get(id);
      if (start !== undefined) out.push({ id, start, end: Number(at) });
    }
  }
  return out;
};

export const overlaps = (a: Interval, b: Interval): boolean => a.start < b.end && b.start < a.end;

/** Runs two gated holders concurrently and returns their intervals. */
export const raceTwo = async (
  dir: string,
  lock: string,
  env: Env = {},
  perChild: Record<string, Env> = {},
): Promise<Interval[]> => {
  const starter = path.join(dir, 'starter.mjs');
  const holder = path.join(dir, 'holder.mjs');
  const gate = path.join(dir, 'go');
  const log = path.join(dir, 'log');
  await fs.writeFile(holder, holderSource);
  await fs.writeFile(starter, starterSource(holder));
  await fs.writeFile(log, '');

  const children = ['a', 'b'].map(
    (id) =>
      new Promise<number>((resolve) => {
        const child = spawn(process.execPath, [starter, gate, log, id, String(HOLD_MS)], {
          stdio: 'ignore',
          env: testEnv(lock, { ...env, ...perChild[id] }),
        });
        child.on('close', (code) => resolve(code ?? 1));
      }),
  );

  for (;;) {
    const ready = await Promise.all(['a', 'b'].map((id) => exists(`${gate}.ready.${id}`)));
    if (ready.every(Boolean)) break;
    await sleep(10);
  }
  await fs.writeFile(gate, '');

  expect(await Promise.all(children)).toEqual([0, 0]);
  const intervals = parseLog(await fs.readFile(log, 'utf8'));
  // Prove the fixture ran at all before reading a verdict out of it: two complete intervals, or
  // "did not overlap" is just "nothing happened".
  expect(intervals).toHaveLength(2);
  return intervals;
};

/** A wrapper that takes the lock and sits on it until released. */
export const heldElsewhere = async (
  dir: string,
  lock: string,
): Promise<{
  release: () => void;
  stillHolding: () => boolean;
  stderr: Promise<string>;
}> => {
  const flag = path.join(dir, 'holding');
  const holder = runWrapper(lock, [
    process.execPath,
    '-e',
    `require('node:fs').writeFileSync(${JSON.stringify(flag)}, ''); setTimeout(() => {}, 20000)`,
  ]);
  while (!(await exists(flag))) await sleep(25);
  return {
    release: () => process.kill(holder.pid as number, 'SIGTERM'),
    stderr: holder.stderr,
    stillHolding: () => {
      try {
        process.kill(holder.pid as number, 0);
        return true;
      } catch {
        return false;
      }
    },
  };
};
