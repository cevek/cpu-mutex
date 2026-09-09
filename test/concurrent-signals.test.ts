// Concurrent runLocked calls in ONE host process share one signal handler over a registry of live
// groups. Per-call handlers would be a silent regression: process.exit inside the first handler
// keeps later-registered listeners from running, so only the first command's group would die —
// the second keeps burning every core with its lock already free. The CLI (single call) cannot
// see this, so the driver here is the programmatic API itself.

import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { exists, sleep, tempLock, testEnv } from './support/wrapper.js';

const DIST_INDEX = fileURLToPath(new URL('../dist/index.js', import.meta.url));

const t = tempLock();

const driverSource = `
import { runLocked } from ${JSON.stringify(pathToFileURL(DIST_INDEX).href)};
const dir = process.argv[2];
const cmd = (id) => {
  const started = JSON.stringify(dir + '/started-' + id);
  const survived = JSON.stringify(dir + '/survived-' + id);
  return [process.execPath, '-e',
    "require('node:fs').writeFileSync(" + started + ", ''); " +
    "setTimeout(() => require('node:fs').writeFileSync(" + survived + ", ''), 5000)"];
};
await Promise.all([
  runLocked(cmd('a'), { file: dir + '/a.lock' }),
  runLocked(cmd('b'), { file: dir + '/b.lock' }),
]);
`;

describe('concurrent runLocked calls in one process', () => {
  it('a signal kills BOTH live groups, not just the first-registered one', async () => {
    const driver = path.join(t.dir, 'driver.mjs');
    await fs.writeFile(driver, driverSource);
    const child = spawn(process.execPath, [driver, t.dir], {
      stdio: 'ignore',
      env: testEnv(t.lock, {}),
    });
    const code = new Promise<number>((resolve) => child.on('close', (c) => resolve(c ?? 1)));

    while (
      !((await exists(path.join(t.dir, 'started-a'))) && (await exists(path.join(t.dir, 'started-b'))))
    ) {
      await sleep(25);
    }
    process.kill(child.pid as number, 'SIGTERM');
    expect(await code).toBe(143);

    await sleep(5_000);
    expect(await exists(path.join(t.dir, 'survived-a'))).toBe(false);
    expect(await exists(path.join(t.dir, 'survived-b'))).toBe(false);
  }, 30_000);
});
