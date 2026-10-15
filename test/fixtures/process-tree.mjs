// an agent under Witch. its commands lead their own sessions, as both agents start them. its MCP server leads its own
// group without a session, as Codex starts it, and has a detached helper. prints the two commands' group ids and the
// server's.
import { spawn } from 'node:child_process';
import process from 'node:process';
import { setInterval } from 'node:timers';

const command = (script) =>
  spawn('/bin/sh', ['-c', script], { detached: true, stdio: 'ignore' });
// its member ignores SIGTERM, as a test stuck in a loop does
const stuck = command(`sh -c 'trap "" TERM; exec sleep 60.5' & wait`);
// its leader stays, and it starts a process that moves to a group of its own and exits once the leader has
const running = command(
  `sleep 61.5 & perl -e 'setpgrp(0, 0); sleep 1 while getppid() != 1' witch-jobs-fixture & wait`,
);
// the server and its helper exit once their parent has
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
