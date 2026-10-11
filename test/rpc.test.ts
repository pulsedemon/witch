import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { JsonRpc } from '../src/agents/json-rpc.js';

function server() {
  return spawn(process.execPath, ['test/fixtures/rpc-server.mjs'], {
    stdio: 'pipe',
  });
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
