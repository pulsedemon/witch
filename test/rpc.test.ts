import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { ClaudeAdapter } from '../src/agents/claude.js';
import { CodexAdapter } from '../src/agents/codex.js';
import { JsonRpc } from '../src/agents/json-rpc.js';

function server() {
  return spawn(
    process.execPath,
    [fileURLToPath(new URL('fixtures/rpc-server.mjs', import.meta.url))],
    { cwd: tmpdir(), stdio: 'pipe' },
  );
}

await test('pairs out-of-order replies with the original request', async () => {
  const rpc = new JsonRpc(server());
  try {
    const first = rpc.request('reverse', { value: 'first' });
    const second = rpc.request('reverse', { value: 'second' });
    assert.deepEqual(await Promise.all([first, second]), [
      { value: 'first' },
      { value: 'second' },
    ]);
  } finally {
    await rpc.close();
  }
});

await test('returns the approval response to the native request id', async () => {
  const rpc = new JsonRpc(server());
  const observed = new Promise<unknown>((resolve) => {
    rpc.onMessage = (message) => {
      if (message.method === 'approve') {
        assert.deepEqual(message.params, { command: 'touch file' });
        rpc.respond(message.id!, { decision: 'decline' });
      } else if (message.method === 'approved') resolve(message.params);
    };
  });
  try {
    rpc.notify('approval', {});
    assert.deepEqual(await observed, { decision: 'decline' });
  } finally {
    await rpc.close();
  }
});

await test('rejects pending requests with the native diagnostic when its process exits', async () => {
  const rpc = new JsonRpc(server());
  const pending = rpc.request('hold', {});
  rpc.notify('exit', {});
  await assert.rejects(pending, /exited.*7.*Native configuration is invalid/);
  await rpc.close();
});

await test('a garbage line from the agent kills it', async () => {
  const child = server();
  const rpc = new JsonRpc(child);
  const exited = new Promise<void>((resolve) =>
    child.once('exit', () => resolve()),
  );
  try {
    rpc.notify('garbage', {});
    await Promise.race([
      exited,
      delay(1000).then(() =>
        assert.fail('the agent outlived its garbage line'),
      ),
    ]);
  } finally {
    child.kill('SIGKILL');
    await rpc.close();
  }
});

for (const adapter of [new CodexAdapter(), new ClaudeAdapter()]) {
  await test(`${adapter.label} with a missing executable fails to connect and cleans up`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'witch-missing-'));
    await Promise.race([
      assert.rejects(
        adapter.connect({
          cwd,
          executable: `/nonexistent/witch-${adapter.id}`,
          memoryDirectories: [],
          onEvent: () => {},
          onProcess: async () => {},
        }),
      ),
      delay(2000).then(() => assert.fail('connect did not settle in 2 s')),
    ]);
  });
}

await test('a failed spawn whose process report rejects at once signals no one', async () => {
  const child = spawn(
    process.execPath,
    [
      '--import',
      import.meta.resolve('tsx'),
      fileURLToPath(new URL('fixtures/failed-spawn.ts', import.meta.url)),
    ],
    { cwd: tmpdir(), detached: true, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  const [code, signal] = (await once(child, 'exit')) as [
    number | null,
    NodeJS.Signals | null,
  ];
  assert.equal(signal, null);
  assert.equal(code, 0);
  assert.equal(output, 'rejected\n');
});
