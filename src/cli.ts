#!/usr/bin/env node
import { LOCK_NAME_RE, MAX_WAIT_S, runLocked, type RunLockedOptions } from './lock.js';

const usage = 'usage: cpu-mutex [--name <lock>] [--wait <seconds>] -- <command> [args...]';

// A function declaration, not a const arrow: TS only narrows after a never-returning call when
// the callee's declared type carries the annotation.
function fail(msg: string): never {
  process.stderr.write(`[cpu-mutex] ${msg}\n${usage}\n`);
  process.exit(2);
}

const rest = process.argv.slice(2);
const opts: RunLockedOptions = {};
let i = 0;
while (i < rest.length) {
  const arg = rest[i]!;
  if (arg === '--') {
    i++;
    break;
  }
  if (arg === '--name' || arg === '--wait') {
    const value = rest[++i];
    if (value === undefined) fail(`${arg} needs a value`);
    if (arg === '--name') {
      if (!LOCK_NAME_RE.test(value)) fail(`--name must match ${LOCK_NAME_RE}`);
      opts.name = value;
    } else {
      if (!/^\d+$/.test(value) || Number(value) <= 0 || Number(value) > MAX_WAIT_S) {
        fail(`--wait takes a positive integer of seconds (max ${MAX_WAIT_S})`);
      }
      opts.waitS = Number(value);
    }
    i++;
    continue;
  }
  if (arg.startsWith('-')) fail(`unknown option ${arg}`);
  break;
}
const command = rest.slice(i);
if (command.length === 0) fail('no command given');

process.exit(await runLocked(command, opts));
