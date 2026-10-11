import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ClaudeAdapter } from '../src/agents/claude.js';
import type { AgentEvent, SessionOptions } from '../src/agents/types.js';

const claude = fileURLToPath(new URL('fixtures/claude.mjs', import.meta.url));

async function launcher(mode?: string) {
  const cwd = await mkdtemp(join(tmpdir(), 'witch-claude-'));
  const children: ChildProcessWithoutNullStreams[] = [];
  const adapter = new ClaudeAdapter((options) => {
    assert.ok(options.args.some((arg) => arg.includes('user,project,local')));
    assert.equal(options.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS, '1');
    const child = spawn(process.execPath, [claude, ...(mode ? [mode] : [])], {
      cwd,
      stdio: 'pipe',
      signal: options.signal,
    });
    children.push(child);
    return child;
  });
  const connect = (options: Partial<SessionOptions> = {}) =>
    adapter.connect({
      cwd,
      executable: '/fake/claude',
      memoryDirectories: [],
      onEvent: () => {},
      onProcess: async () => {},
      ...options,
    });
  return { cwd, children, connect };
}

async function fixture(
  onEvent: (event: AgentEvent) => void = () => {},
  mode?: string,
) {
  const { cwd, children, connect } = await launcher(mode);
  const session = await connect({ onEvent });
  return { session, cwd, child: children[0]! };
}

async function within<T>(promise: Promise<T>, milliseconds: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`no result within ${milliseconds} ms`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** resolves on the first text event, so an interrupt can't land ahead of the queued prompt. */
function working() {
  const seen = Promise.withResolvers<void>();
  const onEvent = (event: AgentEvent) => {
    if (event.type === 'text' && event.text === 'Working.') seen.resolve();
  };
  return { seen: seen.promise, onEvent };
}

await test('refresh consumes a fresh native catalog without replacing the default system prompt', async () => {
  const { session, cwd } = await fixture();
  try {
    assert.deepEqual(
      (await session.models()).map((model) => model.id),
      ['claude-a'],
    );
    assert.deepEqual(
      (await session.models(true)).map((model) => model.id),
      ['claude-b'],
    );
    const initialize = JSON.parse(
      await readFile(join(cwd, 'initialize.json'), 'utf8'),
    );
    assert.equal(initialize.systemPrompt, undefined);
  } finally {
    await session.close();
  }
});

await test('invalid effort preserves the displayed and native model', async () => {
  const { session, cwd } = await fixture();
  try {
    await session.selectModel('claude-a', 'low');
    await assert.rejects(session.selectModel('claude-b', 'invalid'));
    assert.equal(session.info.model, 'claude-a');
    assert.equal((await session.send('report model')).status, 'completed');
    assert.equal(session.info.model, 'claude-a');
    assert.deepEqual(
      JSON.parse(await readFile(join(cwd, 'settings.json'), 'utf8')),
      { effortLevel: 'low' },
    );
  } finally {
    await session.close();
  }
});

await test('a model chosen without an effort keeps the effort in force and sends none', async () => {
  const { session, cwd } = await fixture();
  try {
    await session.selectModel('claude-a', 'high');
    await session.selectModel('claude-b');
    assert.equal(session.info.effort, 'high');
    const payloads = (await readFile(join(cwd, 'settings.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    for (const payload of payloads.slice(1))
      assert.equal('effortLevel' in payload, false);
  } finally {
    await session.close();
  }
});

await test(
  'a result followed by running and requires_action waits for native idle',
  { timeout: 3000 },
  async () => {
    const progress = new Map(
      ['running', 'requires_action'].map((state) => [
        state,
        Promise.withResolvers<void>(),
      ]),
    );
    const { session, cwd } = await fixture((event) => {
      if (event.type === 'text') progress.get(event.text)?.resolve();
    });
    try {
      let completed = false;
      const turn = session.send('wait for idle').then((value) => {
        completed = true;
        return value;
      });
      for (const [state, observed] of progress) {
        await writeFile(join(cwd, `allow-${state}`), 'yes');
        await observed.promise;
        assert.equal(completed, false, `turn completed at ${state}`);
      }
      await writeFile(join(cwd, 'allow-idle'), 'yes');
      assert.deepEqual(await turn, { status: 'completed', text: 'Finished.' });
    } finally {
      await session.close();
    }
  },
);

for (const decision of ['accept', 'decline'] as const) {
  await test(`Claude approval ${decision} returns the matching tool decision`, async () => {
    const { session, cwd } = await fixture((event) => {
      if (event.type === 'request')
        active.respond(event.request.id, { decision });
    });
    const active = session;
    try {
      assert.equal((await session.send('approval')).status, 'completed');
      if (decision === 'accept')
        assert.equal(
          await readFile(join(cwd, 'approved.txt'), 'utf8'),
          'accepted',
        );
      else await assert.rejects(access(join(cwd, 'approved.txt')));
    } finally {
      await session.close();
    }
  });
}

await test('a mid-turn interrupt ends the turn with the native result', async () => {
  const { seen, onEvent } = working();
  const { session } = await fixture(onEvent);
  try {
    const turn = session.send('wait');
    await within(seen, 2000);
    await within(session.interrupt(), 2000);
    assert.deepEqual(await within(turn, 2000), {
      status: 'interrupted',
      text: 'Finished.',
    });
  } finally {
    await session.close();
  }
});

await test('an interrupt that leaves the prompt queued closes the session', async () => {
  const { seen, onEvent } = working();
  const { session, child } = await fixture(onEvent);
  try {
    const exited = once(child, 'exit');
    const turn = session.send('still queued');
    await within(seen, 2000);
    await within(session.interrupt(), 2000);
    assert.equal(session.closed, true);
    assert.deepEqual(await turn, { status: 'interrupted', text: 'Working.' });
    await within(exited, 1000);
  } finally {
    await session.close();
  }
});

await test('a CLI that exits mid-turn ends the turn only once its stderr is complete', async () => {
  const { seen, onEvent } = working();
  const { session, child } = await fixture(onEvent);
  try {
    const exited = once(child, 'exit');
    let finished = false;
    const turn = session.send('crash').then((result) => {
      finished = true;
      return result;
    });
    await within(seen, 2000);
    await within(exited, 2000);
    const deadline = Date.now() + 1000;
    while (!session.closed) {
      assert.ok(Date.now() < deadline, 'the session never closed');
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(finished, false);
    await assert.rejects(session.send('again'), /closed/);
    await within(session.interrupt(), 2000);
    const result = await within(turn, 2000);
    assert.equal(result.status, 'interrupted');
    assert.match(result.error ?? '', /fixture stderr text/);
    assert.match(result.error ?? '', /grandchild line/);
  } finally {
    await session.close();
  }
});

await test('an interrupt after the CLI died resolves and the turn ends', async () => {
  const { seen, onEvent } = working();
  const { session, child } = await fixture(onEvent);
  try {
    const exited = once(child, 'exit');
    const turn = session.send('die');
    await within(seen, 2000);
    await within(exited, 2000);
    await within(session.interrupt(), 2000);
    assert.equal((await within(turn, 2000)).status, 'interrupted');
  } finally {
    await session.close();
  }
});

await test('a CLI that exits cleanly before idle fails the turn with its stderr', async () => {
  const { session } = await fixture();
  try {
    const result = await within(session.send('quit early'), 2000);
    assert.equal(result.status, 'failed');
    assert.match(result.error ?? '', /exited before reporting idle/);
    assert.match(result.error ?? '', /quitting early/);
  } finally {
    await session.close();
  }
});

await test('a CLI that dies while idle posts its stderr as a notice', async () => {
  const notice = Promise.withResolvers<string>();
  const { session } = await fixture((event) => {
    if (event.type === 'notice') notice.resolve(event.text);
  }, 'exit-when-idle');
  try {
    assert.equal((await session.send('hello')).status, 'completed');
    assert.match(await within(notice.promise, 2000), /grandchild line/);
  } finally {
    await session.close();
  }
});

await test('a failed initialize reports the CLI stderr even while the CLI lives', async () => {
  const { children, connect } = await launcher('init-error');
  try {
    await assert.rejects(within(connect(), 3000), /init failed text/);
  } finally {
    for (const child of children) child.kill('SIGKILL');
  }
});

await test('a process report that rejects fails the connect without an unhandled rejection', async () => {
  const unhandled: unknown[] = [];
  const record = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', record);
  try {
    const { connect } = await launcher();
    await assert.rejects(
      connect({
        onProcess: async (pid) => {
          if (pid !== undefined) throw new Error('no process record');
        },
      }),
      /no process record/,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', record);
  }
});
