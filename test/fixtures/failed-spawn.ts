import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { CodexAdapter } from '../../src/agents/codex/adapter.js';

const rejected = new Error('rejected at once');
let spawnError: NodeJS.ErrnoException | undefined;

const adapter = new CodexAdapter((executable, cwd, signal) => {
  const child = spawn(executable, [], { cwd, stdio: 'pipe', signal });

  child.once('error', (error) => {
    spawnError = error;
  });

  return child;
});

// top-level await lets the process report reject before Node emits the spawn error.
await assert.rejects(
  adapter.connect({
    cwd: process.cwd(),
    executable: '/nonexistent/witch-codex',
    memoryDirectories: [],
    onEvent: () => {},
    onProcess: async () => {
      throw rejected;
    },
  }),
  (error: unknown) => error === rejected,
);

assert.equal(spawnError?.code, 'ENOENT');
process.stdout.write('rejected\n');
