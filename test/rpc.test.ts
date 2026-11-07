import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { test } from 'vitest';
import { fileURLToPath } from 'node:url';
import { ClaudeAdapter } from '../src/agents/claude.js';
import { CodexAdapter } from '../src/agents/codex.js';
import { JsonRpc } from '../src/agents/json-rpc.js';
import type { RpcMessage } from '../src/agents/json-rpc.js';
import { scratch } from './fixtures/scratch.js';
import { settled, within } from './fixtures/within.js';

function server(ignoreTerm = false) {
  return spawn(
    process.execPath,
    [
      fileURLToPath(new URL('fixtures/rpc-server.mjs', import.meta.url)),
      ...(ignoreTerm ? ['--ignore-term'] : []),
    ],
    { cwd: tmpdir(), stdio: 'pipe' },
  );
}

test('RPC close escalates an unresponsive child and rejects pending requests once', async () => {
  const child = server(true);
  const rpc = new JsonRpc(child);
  let exits = 0;
  rpc.onExit = () => {
    exits++;
  };
  try {
    await write(child, rpc, Buffer.from('{"method":"ready"}\n'));
    const rejected = assert.rejects(rpc.request('hold', {}), /exited/);
    const started = performance.now();
    const first = rpc.close({ deadline: started + 1200 });
    const second = rpc.close({ deadline: started + 4000 });
    assert.deepEqual(await Promise.all([first, second]), [true, true]);
    await rejected;
    assert.ok(performance.now() - started < 1200);
    assert.equal(child.signalCode, 'SIGKILL');
    assert.equal(exits, 1);
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
    await rpc.close();
  }
});

test('RPC restart closure retains the existing SIGTERM policy', async () => {
  const child = server(true);
  const rpc = new JsonRpc(child);
  let stopped = false;
  try {
    await write(child, rpc, Buffer.from('{"method":"ready"}\n'));
    const closing = rpc
      .close({ restart: true, deadline: performance.now() + 50 })
      .then((escalated) => {
        stopped = true;
        return escalated;
      });
    await delay(150);
    assert.equal(stopped, false);
    assert.equal(child.signalCode, null);
    child.kill('SIGKILL');
    assert.equal(
      await within(closing, 2000, 'test-owned restart cleanup'),
      false,
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
    await rpc.close();
  }
});

/** waits for each chunk to arrive so pipe buffering cannot hide a split. */
async function write(
  child: ReturnType<typeof server>,
  rpc: JsonRpc,
  bytes: Buffer,
) {
  const received = once(child.stdout, 'data');
  rpc.notify('write', { bytes: [...bytes] });
  await within(received, 2000, 'the output chunk');
}

test('preserves Unicode separators across fragmented UTF-8 messages', async () => {
  const child = server();
  const rpc = new JsonRpc(child);
  const messages: RpcMessage[] = [];
  rpc.onMessage = (message) => messages.push(message);
  const text = String.fromCodePoint(0x2028, 0x2029, 0x1f600);
  const frames = Buffer.from(
    `${JSON.stringify({ method: 'text', params: { text } })}\n` +
      `${JSON.stringify({ id: 1, result: { text: `reply ${text}` } })}\r\n` +
      `${JSON.stringify({ method: 'after', params: { value: 'last' } })}\n`,
  );
  const first = frames.indexOf(Buffer.from(String.fromCodePoint(0x2028))) + 1;
  const second = frames.indexOf(Buffer.from(String.fromCodePoint(0x1f600))) + 2;
  const reply = rpc.request('hold', {});
  void reply.catch(() => {});
  try {
    await write(child, rpc, frames.subarray(0, first));
    assert.deepEqual(messages, []);
    await write(child, rpc, frames.subarray(first, second));
    assert.deepEqual(messages, []);
    await write(child, rpc, frames.subarray(second));
    assert.deepEqual(await within(reply, 2000, 'the reply'), {
      text: `reply ${text}`,
    });
    assert.deepEqual(messages, [
      { method: 'text', params: { text } },
      { method: 'after', params: { value: 'last' } },
    ]);
    const next = rpc.request('hold', {});
    void next.catch(() => {});
    await write(child, rpc, Buffer.from('{"id":2,"result":"continued"}\n'));
    assert.equal(await within(next, 2000, 'the next reply'), 'continued');
  } finally {
    await rpc.close();
  }
});

test('reads a final reply without a newline when stdout ends', async () => {
  const child = server();
  const rpc = new JsonRpc(child);
  const reply = rpc.request('hold', {});
  const isSettled = settled(reply);
  try {
    await write(child, rpc, Buffer.from('{"id":1,"result":"final"}'));
    assert.equal(isSettled(), false);
    rpc.notify('end', {});
    assert.equal(await within(reply, 2000, 'the final reply'), 'final');
  } finally {
    await rpc.close();
  }
});

test('rejects a truncated reply when stdout ends', async () => {
  const child = server();
  const rpc = new JsonRpc(child);
  const rejected = assert.rejects(rpc.request('hold', {}), SyntaxError);
  try {
    await write(child, rpc, Buffer.from('{"id":1,"result":"partial'));
    rpc.notify('end', {});
    await within(rejected, 2000, 'the truncated reply');
    await within(once(child, 'close'), 2000, 'the failed agent');
    assert.equal(child.signalCode, 'SIGTERM');
  } finally {
    await rpc.close();
  }
});

test('pairs out-of-order replies with the original request', async () => {
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

test('returns the approval response to the native request id', async () => {
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

test('rejects pending requests with the native diagnostic when its process exits', async () => {
  const rpc = new JsonRpc(server());
  const pending = rpc.request('hold', {});
  rpc.notify('exit', {});
  await assert.rejects(pending, /exited.*7.*Native configuration is invalid/);
  await rpc.close();
});

test('a garbage line from the agent kills it', async () => {
  const child = server();
  const rpc = new JsonRpc(child);
  try {
    rpc.notify('garbage', {});
    await within(once(child, 'exit'), 1000, 'the agent exit');
  } finally {
    child.kill('SIGKILL');
    await rpc.close();
  }
});

for (const adapter of [new CodexAdapter(), new ClaudeAdapter()]) {
  test(`${adapter.label} refuses a missing executable before starting or reporting a process`, async () => {
    const cwd = await scratch('witch-missing-');
    const reports: (number | undefined)[] = [];
    await within(
      assert.rejects(
        adapter.connect({
          cwd,
          executable: `/nonexistent/witch-${adapter.id}`,
          memoryDirectories: [],
          onEvent: () => {},
          onProcess: async (pid) => {
            reports.push(pid);
          },
        }),
        /Native executable not found/,
      ),
      2000,
      'connect',
    );
    assert.deepEqual(reports, []);
  });
}

test('a failed spawn whose process report rejects at once signals no one', async () => {
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
