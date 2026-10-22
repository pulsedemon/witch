import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ClaudeAdapter } from '../src/agents/claude.js';
import { CodexAdapter } from '../src/agents/codex.js';
import { scratch } from './fixtures/scratch.js';
import { within } from './fixtures/within.js';

async function discovery(t: TestContext, agent: string, first = 'catalog') {
  const cwd = await scratch('witch-discovery-');
  const children: { child: ChildProcessWithoutNullStreams; closed: boolean }[] =
    [];
  const args: string[][] = [];
  const start = (signal?: AbortSignal) => {
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL(`fixtures/${agent}.mjs`, import.meta.url)),
        children.length ? 'catalog' : first,
      ],
      { cwd, stdio: 'pipe', signal },
    );
    const entry = { child, closed: false };
    child.once('close', () => {
      entry.closed = true;
    });
    children.push(entry);
    t.after(async () => {
      if (entry.closed) return;
      const closing = new Promise<void>((resolve) =>
        child.once('close', () => resolve()),
      );
      child.kill();
      await closing;
    });
    return child;
  };
  const adapter =
    agent === 'claude'
      ? new ClaudeAdapter((options) => {
          args.push(options.args);
          return start(options.signal);
        })
      : new CodexAdapter((_, _cwd, signal) => start(signal));
  return {
    children,
    args,
    read: (signal?: AbortSignal) =>
      adapter.models({ cwd, executable: '/fixture', signal }),
    wire: async () =>
      (await readFile(join(cwd, 'wire.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map(
          (line) =>
            JSON.parse(line) as {
              method?: string;
              type?: string;
              request?: { subtype: string };
            },
        ),
  };
}

await test('standalone Codex catalogs include every page without opening a thread', async (t) => {
  const probe = await discovery(t, 'codex');
  assert.deepEqual(await probe.read(), [
    { id: 'model-a', label: 'A', efforts: ['low'] },
    { id: 'model-b', label: 'B', efforts: ['high'] },
  ]);
  assert.deepEqual(
    (await probe.wire()).map((frame) => frame.method),
    ['initialize', 'initialized', 'model/list', 'model/list'],
  );
  assert.equal(probe.children[0]!.closed, true);
});

await test('standalone Claude catalogs preserve settings without prompts or history', async (t) => {
  const probe = await discovery(t, 'claude');
  assert.deepEqual(await probe.read(), [
    { id: 'claude-a', label: 'Claude fixture', efforts: ['low', 'high'] },
  ]);
  const args = probe.args[0]!;
  assert.ok(args.includes('--no-session-persistence'));
  assert.ok(args.includes('--strict-mcp-config'));
  assert.ok(args.includes('--setting-sources=user,project,local'));
  assert.deepEqual(JSON.parse(args[args.indexOf('--settings') + 1]!), {
    disableAllHooks: true,
  });
  for (const flag of ['--resume', '--model', '--session-id'])
    assert.ok(!args.some((arg) => arg === flag || arg.startsWith(`${flag}=`)));
  assert.deepEqual(
    (await probe.wire()).map((frame) => [frame.type, frame.request?.subtype]),
    [['control_request', 'initialize']],
  );
  assert.equal(probe.children[0]!.closed, true);
});

for (const agent of ['claude', 'codex']) {
  await test(`${agent} discovery joins initialization failure cleanup and can retry`, async (t) => {
    const probe = await discovery(t, agent, 'exit-on-init');
    await assert.rejects(
      within(probe.read(), 3000, 'discovery failure'),
      /init exit text/,
    );
    assert.equal(probe.children[0]!.closed, true);
    assert.ok((await probe.read()).length > 0);
    assert.equal(probe.children[1]!.closed, true);
  });
  for (const alreadyAborted of [false, true]) {
    await test(`${agent} discovery joins ${alreadyAborted ? 'pre-aborted' : 'pending'} cancellation`, async (t) => {
      const probe = await discovery(t, agent, 'hang-on-init');
      const abort = new AbortController();
      if (alreadyAborted) abort.abort();
      const pending = probe.read(abort.signal);
      const rejected = assert.rejects(
        within(pending, 3000, 'discovery abort'),
        { name: 'AbortError' },
      );
      if (!alreadyAborted) {
        await once(probe.children[0]!.child, 'spawn');
        abort.abort();
      }
      await rejected;
      assert.equal(probe.children[0]!.closed, true);
      assert.ok((await probe.read()).length > 0);
      assert.equal(probe.children[1]!.closed, true);
    });
  }
}
