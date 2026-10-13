import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, access, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { CodexAdapter } from '../src/agents/codex.js';
import type { AgentEvent, AgentSession, Usage } from '../src/agents/types.js';
import { within } from './fixtures/within.js';

const codex = fileURLToPath(new URL('fixtures/codex.mjs', import.meta.url));

async function fixture(
  onEvent: (event: AgentEvent) => void = () => {},
  {
    effort,
    resume,
    mode,
    signal,
  }: {
    effort?: string;
    resume?: string;
    mode?: string;
    signal?: AbortSignal;
  } = {},
) {
  const cwd = await mkdtemp(join(tmpdir(), 'witch-codex-'));
  const adapter = new CodexAdapter((_, directory, signal) =>
    spawn(process.execPath, [codex, ...(mode ? [mode] : [])], {
      cwd: directory,
      stdio: 'pipe',
      signal,
    }),
  );
  const session = await adapter.connect({
    cwd,
    executable: 'codex',
    effort,
    resume,
    signal,
    memoryDirectories: ['/shared/global', '/shared/project'],
    onEvent,
    onProcess: async () => {},
  });
  return { session, cwd };
}

/** lets a held fixture event go, so a reverted guard can't hang cleanup. */
async function close(session: AgentSession, cwd: string) {
  await writeFile(join(cwd, 'release'), 'yes');
  await session.close();
}

async function appears(path: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (
      await access(path).then(
        () => true,
        () => false,
      )
    )
      return;
    await delay(10);
  }
  assert.fail(`${path} never appeared`);
}

function settled(promise: Promise<unknown>) {
  let done = false;
  void promise.then(
    () => (done = true),
    () => (done = true),
  );
  return () => done;
}

await test('loads every model page and preserves native roots without overriding instructions', async () => {
  const { session, cwd } = await fixture();
  try {
    assert.deepEqual(
      (await session.models()).map((model) => [model.id, model.efforts]),
      [
        ['model-a', ['low']],
        ['model-b', ['high']],
      ],
    );
    const start = JSON.parse(await readFile(join(cwd, 'start.json'), 'utf8'));
    assert.equal(start.params.baseInstructions, undefined);
    assert.equal(start.params.developerInstructions, undefined);
    assert.deepEqual(
      start.params.config['sandbox_workspace_write.writable_roots'],
      ['/already-allowed', '/shared/global', '/shared/project'],
    );
  } finally {
    await close(session, cwd);
  }
});

await test('a Codex that exits while idle posts the exit as a notice', async () => {
  const notice = Promise.withResolvers<string>();
  const { session, cwd } = await fixture((event) => {
    if (event.type === 'notice') notice.resolve(event.text);
  });
  try {
    assert.equal((await session.send('exit when idle')).status, 'completed');
    assert.ok(await within(notice.promise, 2000, 'exit notice'));
  } finally {
    await close(session, cwd).catch(() => {});
  }
});

await test('closing a Codex session posts no exit notice', async () => {
  const notices: AgentEvent[] = [];
  const { session, cwd } = await fixture((event) => {
    if (event.type === 'notice') notices.push(event);
  });
  await close(session, cwd);
  assert.deepEqual(notices, []);
});

await test('a Codex that exits during a model change fails the change without a notice', async () => {
  const notices: AgentEvent[] = [];
  const { session, cwd } = await fixture((event) => {
    if (event.type === 'notice') notices.push(event);
  });
  try {
    await assert.rejects(within(session.selectModel('exit'), 2000, 'exit'));
    assert.deepEqual(notices, []);
  } finally {
    await close(session, cwd).catch(() => {});
  }
});

await test('an aborted connect rejects', async () => {
  const controller = new AbortController();
  const connecting = fixture(() => {}, {
    mode: 'hang-on-init',
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(within(connecting, 3000, 'connect'), /aborted/);
});

await test('a stored thread resumes by its id, and a missing one fails the connect with no exit notice', async () => {
  const events: AgentEvent[] = [];
  await assert.rejects(
    fixture((event) => events.push(event), { resume: 'stored-thread' }).then(
      ({ session, cwd }) => close(session, cwd),
    ),
    /no rollout found for thread id stored-thread/,
  );
  assert.deepEqual(events, []);
});

await test('a request Codex resolves itself leaves the queue before the turn ends', async () => {
  const events: AgentEvent[] = [];
  const { session, cwd } = await fixture((event) => events.push(event));
  try {
    const turn = session.send('withdrawn');
    await appears(join(cwd, 'replied'));
    await delay(50);
    assert.deepEqual(
      events
        .map((event) => event.type)
        .filter((type) => type.startsWith('request')),
      ['request', 'request-resolved'],
    );
    await writeFile(join(cwd, 'release'), 'yes');
    assert.equal((await turn).status, 'completed');
  } finally {
    await close(session, cwd);
  }
});

await test('an accepted permissions request grants the requested permissions for the turn', async () => {
  const { session, cwd } = await fixture((event) => {
    if (event.type === 'request')
      session.respond(event.request.id, { decision: 'accept' });
  });
  try {
    assert.equal((await session.send('permissions')).status, 'completed');
    assert.deepEqual(
      JSON.parse(await readFile(join(cwd, 'response-91.json'), 'utf8')),
      { permissions: { network: { enabled: true } }, scope: 'turn' },
    );
  } finally {
    await close(session, cwd);
  }
});

await test('a file change approval reaches the user and returns its decision', async () => {
  const kinds: string[] = [];
  const { session, cwd } = await fixture((event) => {
    if (event.type !== 'request') return;
    kinds.push(event.request.kind);
    session.respond(event.request.id, { decision: 'accept' });
  });
  try {
    assert.equal(
      (await within(session.send('file change'), 2000, 'file change turn'))
        .status,
      'completed',
    );
    assert.deepEqual(kinds, ['approval']);
    assert.deepEqual(
      JSON.parse(await readFile(join(cwd, 'response-94.json'), 'utf8')),
      { decision: 'accept' },
    );
  } finally {
    await close(session, cwd);
  }
});

for (const decision of ['accept', 'decline'] as const) {
  await test(`native approval ${decision} controls the requested side effect`, async () => {
    const { session, cwd } = await fixture((event) => {
      if (event.type === 'request')
        session.respond(event.request.id, { decision });
    });
    try {
      await session.selectModel('model-b', 'high');
      assert.equal(session.info.model, 'model-b');
      assert.deepEqual(await session.send('do the task'), {
        status: 'completed',
        text: 'Finished.',
      });
      const prompt = JSON.parse(
        await readFile(join(cwd, 'prompt.json'), 'utf8'),
      );
      assert.equal(prompt.params.effort, 'high');
      assert.equal(prompt.params.input[0].text, 'do the task');
      assert.equal(prompt.params.threadId, 'native-thread');
      assert.equal(session.info.permissionMode, 'on-request / user');
      if (decision === 'accept')
        assert.equal(
          await readFile(join(cwd, 'approved.txt'), 'utf8'),
          'approved',
        );
      else await assert.rejects(access(join(cwd, 'approved.txt')));
    } finally {
      await close(session, cwd);
    }
  });
}

await test('skills keep the first enabled entry per name and prefer its interface description', async () => {
  const changed = Promise.withResolvers<AgentEvent>();
  const { session, cwd } = await fixture((event) => {
    if (event.type === 'skills') changed.resolve(event);
  });
  try {
    assert.deepEqual(await session.skills(), [
      { name: 'review', description: 'review interface' },
      { name: 'legacy', description: 'legacy short' },
      { name: 'bare', description: 'bare description' },
    ]);
    assert.deepEqual(
      JSON.parse(await readFile(join(cwd, 'skills.json'), 'utf8')).params,
      { cwds: [cwd], forceReload: true },
    );
    assert.equal((await session.send('add skill')).status, 'completed');
    const event = await within(changed.promise, 2000, 'skills change');
    assert.deepEqual(
      event.type === 'skills' && event.skills.map(({ name }) => name),
      ['review', 'legacy', 'bare', 'later'],
    );
  } finally {
    await close(session, cwd);
  }
});

await test('a skill send names the first listed path, and a plain send names none', async () => {
  const { session, cwd } = await fixture();
  const input = async () =>
    JSON.parse(await readFile(join(cwd, 'prompt.json'), 'utf8')).params
      .input as unknown;
  try {
    await session.skills();
    await session.send('add skill', { name: 'review', args: 'x' });
    assert.deepEqual(await input(), [
      { type: 'text', text: 'add skill', text_elements: [] },
      { type: 'skill', name: 'review', path: '/skills/review/SKILL.md' },
    ]);
    await session.send('add skill');
    assert.deepEqual(await input(), [
      { type: 'text', text: 'add skill', text_elements: [] },
    ]);
  } finally {
    await close(session, cwd);
  }
});

await test('interrupt waits for the native turn to complete', async () => {
  const { session, cwd } = await fixture();
  try {
    const turn = session.send('hold');
    await appears(join(cwd, 'prompt.json'));
    const interrupting = session.interrupt();
    const done = settled(interrupting);
    await appears(join(cwd, 'replied'));
    await delay(50);
    assert.equal(done(), false);
    await writeFile(join(cwd, 'release'), 'yes');
    await within(interrupting, 2000, 'interrupt');
    assert.equal((await turn).status, 'interrupted');
  } finally {
    await close(session, cwd);
  }
});

await test('model selection waits for the settings notification', async () => {
  const { session, cwd } = await fixture();
  try {
    const selecting = session.selectModel('held');
    const done = settled(selecting);
    await appears(join(cwd, 'replied'));
    await delay(50);
    assert.equal(done(), false);
    await writeFile(join(cwd, 'release'), 'yes');
    await within(selecting, 2000, 'model selection');
  } finally {
    await close(session, cwd);
  }
});

await test('malformed notifications post one notice per method and the turn completes', async () => {
  const notices: string[] = [];
  const { session, cwd } = await fixture((event) => {
    if (event.type === 'notice') notices.push(event.text);
  });
  try {
    assert.equal(
      (await within(session.send('malformed'), 2000, 'malformed turn')).status,
      'completed',
    );
    assert.equal(notices.length, 1);
    assert.match(notices[0]!, /item\/agentMessage\/delta/);
  } finally {
    await close(session, cwd);
  }
});

await test('a retried native error posts a notice, and the final one only fails the turn', async () => {
  const notices: string[] = [];
  const { session, cwd } = await fixture((event) => {
    if (event.type === 'notice') notices.push(event.text);
  });
  try {
    const result = await session.send('error');
    assert.deepEqual([result.status, result.error], ['failed', 'native error']);
    assert.deepEqual(notices, ['retrying']);
  } finally {
    await close(session, cwd);
  }
});

await test('a malformed settings notification fails the model change', async () => {
  const { session, cwd } = await fixture();
  try {
    await assert.rejects(
      within(session.selectModel('bad-settings'), 2000, 'settings update'),
      /thread\/settings\/updated/,
    );
  } finally {
    await close(session, cwd);
  }
});

for (const [prompt, error] of [
  ['null-turn', /turn\/completed/],
  ['in-progress', /status inProgress/],
  ['failed', /^native failure$/],
] as const) {
  await test(`a turn completed as ${prompt} fails only that turn`, async () => {
    const { session, cwd } = await fixture();
    try {
      const result = await within(session.send(prompt), 2000, `${prompt} turn`);
      assert.equal(result.status, 'failed');
      assert.match(result.error ?? '', error);
      assert.equal(session.closed, false);
    } finally {
      await close(session, cwd);
    }
  });
}

await test('an unparseable native request gets an error reply and the turn continues', async () => {
  const notices: string[] = [];
  const { session, cwd } = await fixture((event) => {
    if (event.type === 'notice') notices.push(event.text);
  });
  try {
    assert.equal(
      (await within(session.send('bad-request'), 2000, 'bad request turn'))
        .status,
      'completed',
    );
    assert.match(
      await readFile(join(cwd, 'error-90.json'), 'utf8'),
      /requestUserInput/,
    );
    assert.match(
      notices.join('\n'),
      /could not read Codex's item\/tool\/requestUserInput request/,
    );
  } finally {
    await close(session, cwd);
  }
});

await test('an unsupported native request gets an error reply and the turn continues', async () => {
  const events: AgentEvent[] = [];
  const { session, cwd } = await fixture((event) => {
    if (event.type === 'request' || event.type === 'notice') events.push(event);
  });
  try {
    assert.equal(
      (await within(session.send('unknown-request'), 2000, 'unknown request'))
        .status,
      'completed',
    );
    assert.match(
      await readFile(join(cwd, 'error-92.json'), 'utf8'),
      /Unsupported native request: item\/unknown\/request/,
    );
    assert.deepEqual(events, [
      {
        type: 'notice',
        text: 'Unsupported native request: item/unknown/request',
      },
    ]);
  } finally {
    await close(session, cwd);
  }
});

await test("a command streams its output into one tool that completes once in the command's cwd, and the user message and reasoning show none", async () => {
  const tools: Extract<AgentEvent, { type: 'tool' }>[] = [];
  const { session, cwd } = await fixture((event) => {
    if (event.type === 'tool') tools.push(event);
  });
  try {
    assert.equal((await session.send('tool')).status, 'completed');
    assert.deepEqual(
      tools.map(({ id, text, done, append, cwd }) => [
        id,
        text,
        done,
        append,
        cwd,
      ]),
      [
        ['cmd-1', '', false, undefined, '/elsewhere'],
        ['cmd-1', 'a.md\n', false, true, undefined],
        ['cmd-1', 'a.md\n', true, undefined, '/elsewhere'],
      ],
    );
  } finally {
    await close(session, cwd);
  }
});

await test('a Codex that exits during initialize fails the connect without a notice', async () => {
  const events: AgentEvent[] = [];
  await assert.rejects(
    within(
      fixture((event) => events.push(event), { mode: 'exit-on-init' }),
      3000,
      'connect',
    ),
    /init exit text/,
  );
  assert.deepEqual(events, []);
});

await test('a grandchild holding the native pipes cannot keep a dead turn open, and the exit posts no notice', async () => {
  const notices: AgentEvent[] = [];
  const { session, cwd } = await fixture((event) => {
    if (event.type === 'notice') notices.push(event);
  });
  try {
    const result = await within(
      session.send('grandchild'),
      1000,
      'grandchild turn',
    );
    assert.equal(result.status, 'failed');
    assert.deepEqual(notices, []);
  } finally {
    const pid = Number(
      await readFile(join(cwd, 'grandchild.pid'), 'utf8').catch(() => '0'),
    );
    if (pid) process.kill(pid, 'SIGKILL');
    await close(session, cwd).catch(() => {});
  }
});

await test("a model chosen without an effort keeps the requested one and never reports Codex's default as requested", async () => {
  const { session, cwd } = await fixture();
  try {
    assert.equal(session.info.effort, undefined);
    await session.selectModel('model-b');
    assert.equal(session.info.effort, undefined);
    await session.selectModel('model-a', 'high');
    await session.selectModel('model-b');
    assert.equal(session.info.effort, 'high');
  } finally {
    await close(session, cwd);
  }
});

await test('a null effort stops requesting one', async () => {
  const { session, cwd } = await fixture();
  try {
    await session.selectModel('model-a', 'high');
    await session.selectModel('model-b', null);
    assert.equal(session.info.effort, undefined);
    assert.equal((await session.send('tool')).status, 'completed');
    const prompt = JSON.parse(await readFile(join(cwd, 'prompt.json'), 'utf8'));
    assert.equal(prompt.params.effort, undefined);
  } finally {
    await close(session, cwd);
  }
});

await test("a turn after connecting with an effort requests it, not Codex's own", async () => {
  const { session, cwd } = await fixture(() => {}, { effort: 'high' });
  try {
    assert.equal((await session.send('tool')).status, 'completed');
    const prompt = JSON.parse(await readFile(join(cwd, 'prompt.json'), 'utf8'));
    assert.equal(prompt.params.effort, 'high');
  } finally {
    await close(session, cwd);
  }
});

await test('a model choice that changes no native setting returns and shows the choice', async () => {
  const { session, cwd } = await fixture(() => {}, { effort: 'high' });
  try {
    assert.equal(session.info.effort, 'high');
    await within(session.selectModel('model-a'), 2000, 'the same model');
    assert.equal(session.info.effort, 'high');
    await within(
      session.selectModel('model-a', 'low'),
      2000,
      'the native effort',
    );
    assert.equal(session.info.effort, 'low');
    await within(session.selectModel('model-a', null), 2000, 'a null effort');
    assert.equal(session.info.effort, undefined);
  } finally {
    await close(session, cwd);
  }
});

await test('a reroute shows the model in use, and choosing the thread model again returns', async () => {
  const { session, cwd } = await fixture();
  try {
    assert.equal((await session.send('reroute')).status, 'completed');
    assert.equal(session.info.model, 'model-c');
    await within(session.selectModel('model-a'), 2000, 'the thread model');
    assert.equal(session.info.model, 'model-a');
  } finally {
    await close(session, cwd);
  }
});

await test('native secret questions and MCP form answers reach their protocol consumers unchanged', async () => {
  const { session, cwd } = await fixture((event) => {
    if (event.type !== 'request') return;
    if (event.request.kind === 'question') {
      assert.equal(event.request.questions?.[0]?.secret, true);
      session.respond(event.request.id, {
        decision: 'accept',
        answers: { value: ['red, green'] },
      });
    } else if (event.request.kind === 'elicitation') {
      assert.deepEqual(event.request.schema, {
        type: 'object',
        properties: { label: { type: 'string' } },
      });
      session.respond(event.request.id, {
        decision: 'accept',
        content: { label: 'violet' },
      });
    }
  });
  try {
    await session.send('question');
    assert.deepEqual(
      JSON.parse(await readFile(join(cwd, 'response-88.json'), 'utf8')),
      { answers: { value: { answers: ['red, green'] } } },
    );
    await session.send('elicitation');
    assert.deepEqual(
      JSON.parse(await readFile(join(cwd, 'response-89.json'), 'utf8')),
      { action: 'accept', content: { label: 'violet' }, _meta: null },
    );
  } finally {
    await close(session, cwd);
  }
});

await test("reports context, lines summed over the thread's turns, limits merged from sparse updates and the cost estimate, leaving out other threads and limits", async () => {
  const reported: Usage[] = [];
  const { session, cwd } = await fixture((event) => {
    if (event.type === 'usage') reported.push(event.usage);
  });
  try {
    for (let attempt = 0; !session.usage.limits && attempt < 400; attempt++)
      await delay(5);
    assert.equal((await session.send('usage')).status, 'completed');
    for (
      let attempt = 0;
      session.usage.cost !== 1.5 && attempt < 400;
      attempt++
    )
      await delay(5);
    assert.deepEqual(session.usage, {
      // 64000 of a 256000-token window
      context: 25,
      lines: { added: 3, removed: 1 },
      limits: [
        { window: '5H', percent: 15, resetsAt: 2000000100 },
        { window: '7D', percent: 40, resetsAt: 2000500000 },
      ],
      cost: 1.5,
    });
    assert.deepEqual(reported.at(-1), session.usage);
  } finally {
    await close(session, cwd);
  }
});

await test('reports the effort Codex runs, its own default first and then the one a settings update makes', async () => {
  const { session, cwd } = await fixture();
  try {
    assert.equal(session.info.nativeEffort, 'low');
    assert.equal(session.info.effort, undefined);
    await session.selectModel('model-b', 'high');
    assert.equal(session.info.nativeEffort, 'high');
  } finally {
    await close(session, cwd);
  }
});
