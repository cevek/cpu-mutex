#!/usr/bin/env node
import {
  LOCK_NAME_RE,
  MAX_TIMEOUT_S,
  MAX_WAIT_S,
  lockStatus,
  runLocked,
  shQuote,
  type RunLockedOptions,
} from './lock.js';

const usage = [
  'usage: cpu-mutex [--name <lock>] [--wait <seconds>] [--timeout <seconds>] -- <command> [args...]',
  '       cpu-mutex --status [--name <lock>]',
].join('\n');

// A function declaration, not a const arrow: TS only narrows after a never-returning call when
// the callee's declared type carries the annotation.
function fail(msg: string): never {
  process.stderr.write(`[cpu-mutex] ${msg}\n${usage}\n`);
  process.exit(2);
}

const rest = process.argv.slice(2);
const opts: RunLockedOptions = {};
let statusMode = false;
let i = 0;
while (i < rest.length) {
  const arg = rest[i]!;
  if (arg === '--') {
    i++;
    break;
  }
  if (arg === '--status') {
    statusMode = true;
    i++;
    continue;
  }
  if (arg === '--name' || arg === '--wait' || arg === '--timeout') {
    const value = rest[++i];
    if (value === undefined) fail(`${arg} needs a value`);
    if (arg === '--name') {
      if (!LOCK_NAME_RE.test(value)) fail(`--name must match ${LOCK_NAME_RE}`);
      opts.name = value;
    } else {
      const max = arg === '--wait' ? MAX_WAIT_S : MAX_TIMEOUT_S;
      if (!/^\d+$/.test(value) || Number(value) <= 0 || Number(value) > max) {
        fail(`${arg} takes a positive integer of seconds (max ${max})`);
      }
      if (arg === '--wait') opts.waitS = Number(value);
      else opts.timeoutS = Number(value);
    }
    i++;
    continue;
  }
  if (arg.startsWith('-')) fail(`unknown option ${arg}`);
  break;
}
const command = rest.slice(i);

if (statusMode) {
  if (command.length > 0) fail('--status takes no command');
  if (opts.waitS !== undefined) fail('--status takes no --wait');
  if (opts.timeoutS !== undefined) fail('--status takes no --timeout');
  const status = lockStatus(opts);
  const line =
    status.busy === null
      ? 'cannot tell — no lockf/flock on this system'
      : !status.busy
        ? 'free'
        : status.holder
          ? `held by pid ${status.holder.pid} since ${status.holder.startedAt} — ` +
            `${status.holder.cwd} (${status.holder.cmd})`
          : 'held — holder not identified';
  process.stdout.write(`${status.file}: ${line}\n`);
  if (status.busy) {
    process.stderr.write(`[cpu-mutex] holders and waiters: lsof ${shQuote(status.file)}\n`);
  }
  // Scriptable: 0 free, 1 held, 3 undeterminable (2 is the usage error, above).
  process.exit(status.busy === null ? 3 : status.busy ? 1 : 0);
}

if (command.length === 0) fail('no command given');

process.exit(await runLocked(command, opts));
