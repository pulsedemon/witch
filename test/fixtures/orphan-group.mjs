// an agent under Witch whose command's shell exits after half a second, leaving a process that then starts one in a
// group of its own, which exits once its parent has. prints the command's group id.
import { spawn } from 'node:child_process';
import process from 'node:process';
import { setInterval } from 'node:timers';

const command = spawn(
  '/bin/sh',
  [
    '-c',
    `(sleep 1; perl -e 'setpgrp(0, 0); sleep 1 while getppid() != 1' witch-jobs-fixture & sleep 62.5) & sleep 0.5`,
  ],
  { detached: true, stdio: 'ignore' },
);
process.stdout.write(`${command.pid}\n`);
setInterval(() => {}, 60_000);
