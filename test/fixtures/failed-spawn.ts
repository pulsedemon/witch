import { CodexAdapter } from '../../src/agents/codex/codex.js';

// awaited at module top level, where connect's catch runs before Node's spawn error
await new CodexAdapter()
  .connect({
    cwd: process.cwd(),
    executable: '/nonexistent/witch-codex',
    memoryDirectories: [],
    onEvent: () => {},
    onProcess: async () => {
      throw new Error('rejected at once');
    },
  })
  .catch(() => {});

process.stdout.write('rejected\n');
