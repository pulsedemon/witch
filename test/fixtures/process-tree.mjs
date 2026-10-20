// commands lead sessions, but the MCP server only leads a group, so its detached helper must stay untracked
import { spawn } from 'node:child_process';
import process from 'node:process';
import { setInterval } from 'node:timers';

const command = (script) =>
  spawn('/bin/sh', ['-c', script], { detached: true, stdio: 'ignore' });
// SIGTERM must leave a member alive so stop has to escalate
const stuck = command(`sh -c 'trap "" TERM; exec sleep 60.5' & wait`);
// the leader waits for the sleep alone, since the other process waits for the leader to exit
const running = command(
  `sleep 61.5 & s=$!; perl -e 'setpgrp(0, 0); sleep 1 while getppid() != 1' witch-jobs-fixture & wait $s`,
);
const server = spawn(
  '/usr/bin/perl',
  [
    '-e',
    'use POSIX; setpgrp(0, 0); if (!fork) { setsid(); sleep 1 while getppid() != 1; exit } sleep 1 while getppid() != 1',
    'witch-jobs-fixture',
  ],
  { stdio: 'ignore' },
);
process.stdout.write(`${stuck.pid} ${running.pid} ${server.pid}\n`);
setInterval(() => {}, 60_000);
