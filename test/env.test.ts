import { describe, expect, it } from 'vitest';
import { heldElsewhere, runWrapper, sleep, tempLock } from './support/wrapper.js';

const t = tempLock();

describe('environment values are validated, not merely parsed', () => {
  // The knob fails the same way when a value is only PARSED: the wrapper hands the utility a token
  // it rejects, reads the rejection as "could not acquire", and runs unserialized — the mutex off
  // for every later run from one typo in an exported variable. A numeric predicate is not enough:
  // `2.5` and `1e21` are finite numbers whose STRING form the utility will not take, and a huge
  // plain-decimal token is past the utility's own numeric range.
  for (const bad of ['2.5', '1e21', 'abc', '0', '-5', '99999999999999999999']) {
    it(`CPU_MUTEX_WAIT_S=${bad} does not disable the lock`, async () => {
      const held = await heldElsewhere(t.dir, t.lock);
      const run = runWrapper(t.lock, [process.execPath, '-e', 'process.exit(0)'], {
        CPU_MUTEX_WAIT_S: bad,
      });
      let finished = false;
      void run.code.then(() => (finished = true));
      await sleep(2_000);
      // Still queued behind the holder: a wrapper that accepted the junk value would already have
      // given up and run without the lock.
      expect(finished).toBe(false);

      held.release();
      await run.code;
      expect(await run.stderr).not.toContain('WITHOUT the lock');
    }, 40_000);
  }

  it('an unrecognized CPU_MUTEX value is reported, not silently treated as unset', async () => {
    const run = runWrapper(t.lock, [process.execPath, '-e', 'process.exit(0)'], {
      CPU_MUTEX: 'true',
    });
    expect(await run.code).toBe(0);
    expect(await run.stderr).toContain("ignoring CPU_MUTEX=\"true\"");
  }, 20_000);
});

describe('the CI switch', () => {
  it('a non-empty CI takes no lock, so a held lock does not delay the run', async () => {
    const held = await heldElsewhere(t.dir, t.lock);
    const code = await runWrapper(t.lock, [process.execPath, '-e', 'process.exit(7)'], {
      CPU_MUTEX: '',
      CI: '1',
    }).code;
    expect(code).toBe(7);
    // The load-bearing half: it finished while the lock was DEMONSTRABLY still held. Asserting the
    // exit code alone is green over a switch that stopped reading CI — the run would simply wait
    // the holder out and still exit 7. Checking liveness instead of elapsed time keeps it immune
    // to machine load.
    expect(held.stillHolding()).toBe(true);
    held.release();
    // …and the holder really held: a holder that had itself degraded to an unlocked run would be
    // alive and holding nothing, which the liveness check alone cannot tell apart.
    expect(await held.stderr).not.toContain('WITHOUT the lock');
  }, 40_000);

  it('CPU_MUTEX=1 beats CI — the run waits for the held lock', async () => {
    const held = await heldElsewhere(t.dir, t.lock);
    const run = runWrapper(t.lock, [process.execPath, '-e', 'process.exit(8)'], { CI: '1' });
    let finished = false;
    void run.code.then(() => (finished = true));
    await sleep(2_500);
    // Still queued: without this priority the discriminating tests above would silently stop
    // testing the lock the moment a repo using it gains a CI job.
    expect(finished).toBe(false);
    held.release();
    expect(await run.code).toBe(8);
  }, 40_000);
});
