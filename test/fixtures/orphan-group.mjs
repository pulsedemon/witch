// an agent under Witch whose command's shell exits after half a second, leaving two processes. one then starts a
// process in a group of its own, which exits once its parent has, and the other moves to a group of its own and exits
// once the agent has. prints the command's group id.
import { spawn } from 'node:child_process';
import process from 'node:process';
import { setInterval } from 'node:timers';

const command = spawn(
  '/bin/sh',
  [
    '-c',
    `(sleep 1; perl -e 'setpgrp(0, 0); sleep 1 while getppid() != 1' witch-jobs-fixture & sleep 62.5) & perl -e 'sleep 1; setpgrp(0, 0); sleep 1 while kill 0, ${process.pid}' witch-jobs-fixture & sleep 0.5`,
  ],
  { detached: true, stdio: 'ignore' },
);
process.stdout.write(`${command.pid}\n`);
setInterval(() => {}, 60_000);
