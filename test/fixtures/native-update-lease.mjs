import process from 'node:process';

import { holdRuntime } from '../../src/persistence/runtime-updates.ts';

const release = holdRuntime(process.argv[2], process.argv[3]);

process.stdout.write('held\n');

process.stdin.resume();

process.stdin.once('end', () => release());
