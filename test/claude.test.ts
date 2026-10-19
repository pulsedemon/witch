import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { access, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, promisify } from 'node:util';
import { ClaudeAdapter } from '../src/agents/claude.js';
import type {
  AgentEvent,
  SessionOptions,
  Usage,
  UserRequest,
} from '../src/agents/types.js';
import { scratch } from './fixtures/scratch.js';
import { until, within } from './fixtures/within.js';

const claude = fileURLToPath(new URL('fixtures/claude.mjs', import.meta.url));

async function launcher(mode?: string) {
  const cwd = await scratch('witch-claude-');
  const children: ChildProcessWithoutNullStreams[] = [];
  const args: string[][] = [];
  const envs: NodeJS.ProcessEnv[] = [];
  const adapter = new ClaudeAdapter((options) => {
    assert.ok(options.args.some((arg) => arg.includes('user,project,local')));
    assert.equal(options.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS, '1');
    args.push(options.args);
    envs.push(options.env);
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
  return { cwd, children, args, envs, connect };
}

async function fixture(
  onEvent: (event: AgentEvent) => void = () => {},
  mode?: string,
) {
  const { cwd, children, connect } = await launcher(mode);
  const session = await connect({ onEvent });
  return { session, cwd, child: children[0]! };
}

/** resolves on the first text event, so an interrupt can't land ahead of the queued prompt. */
function working() {
  const seen = Promise.withResolvers<void>();
  const onEvent = (event: AgentEvent) => {
    if (event.type === 'text' && event.text === 'Working.') seen.resolve();
  };
  return { seen: seen.promise, onEvent };
}

/** the JSON lines the fixture wrote, or none while the file is missing or half written. */
async function jsonLines(file: string): Promise<unknown[]> {
  try {
    return (await readFile(file, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as unknown);
  } catch {
    return [];
  }
}

const content = async (cwd: string) =>
  JSON.parse(await readFile(join(cwd, 'content.json'), 'utf8')) as unknown;

await test('a stored effort reaches Claude Code on connect and shows before any model change', async () => {
  const { args, connect } = await launcher();
  const session = await connect({ effort: 'high' });
  try {
    assert.ok(args[0]!.includes('--effort=high'), JSON.stringify(args[0]));
    assert.equal(session.info.effort, 'high');
  } finally {
    await session.close();
  }
});

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

await test('skills leave out built-ins and the rows they shadow, before and after a native change', async () => {
  const events: AgentEvent[] = [];
  const { session } = await fixture((event) => events.push(event));
  try {
    assert.deepEqual(await session.skills(), [
      {
        name: 'review',
        description: 'Review changes',
        argumentHint: '<target>',
      },
    ]);
    assert.equal((await session.send('add skill')).status, 'completed');
    assert.deepEqual(
      events.filter((event) => event.type === 'skills'),
      [
        {
          type: 'skills',
          skills: [{ name: 'later', description: 'Added later' }],
        },
      ],
    );
  } finally {
    await session.close();
  }
});

await test('a skill goes last after its context, and a plain prompt stays a string', async () => {
  const { session, cwd } = await fixture();
  try {
    await session.send('context', { name: 'review', args: 'main' });
    assert.deepEqual(await content(cwd), [
      { type: 'text', text: 'context' },
      { type: 'text', text: '/review main' },
    ]);
    await session.send('plain');
    assert.equal(await content(cwd), 'plain');
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
    assert.deepEqual(await jsonLines(join(cwd, 'settings.jsonl')), [
      { effortLevel: 'high' },
    ]);
  } finally {
    await session.close();
  }
});

await test('a null effort clears the effort in force', async () => {
  const { session, cwd } = await fixture();
  try {
    await session.selectModel('claude-a', 'high');
    await session.selectModel('claude-b', null);
    assert.equal(session.info.effort, undefined);
    assert.deepEqual(
      JSON.parse(await readFile(join(cwd, 'settings.json'), 'utf8')),
      { effortLevel: null },
    );
  } finally {
    await session.close();
  }
});

await test('a new session has history and the native permission mode once its first prompt starts', async () => {
  const { session } = await fixture();
  try {
    assert.equal(session.info.hasHistory, false);
    await session.send('hello');
    assert.equal(session.info.hasHistory, true);
    assert.equal(session.info.permissionMode, 'default');
  } finally {
    await session.close();
  }
});

await test('a stored session resumes by its id instead of starting a new one', async () => {
  const { args, connect } = await launcher();
  const session = await connect({ resume: 'stored-session' });
  try {
    assert.ok(args[0]!.includes('--resume=stored-session'));
    assert.ok(!args[0]!.some((arg) => arg.startsWith('--session-id')));
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
        session.respond(event.request.id, { decision });
    });
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

await test('a Claude question lists its choices and returns a multiple choice joined', async () => {
  const requests: UserRequest[] = [];
  const { session, cwd } = await fixture((event) => {
    if (event.type !== 'request') return;
    requests.push(event.request);
    session.respond(event.request.id, {
      decision: 'accept',
      answers: { 'Colors?': ['red', 'green'] },
    });
  });
  try {
    assert.equal((await session.send('question')).status, 'completed');
    assert.equal(requests[0]?.kind, 'question');
    assert.deepEqual(requests[0]?.questions, [
      {
        id: 'Colors?',
        title: 'Colors?',
        options: ['red', 'green', 'blue'],
        multiple: true,
      },
    ]);
    const response = JSON.parse(
      await readFile(join(cwd, 'response.json'), 'utf8'),
    );
    assert.equal(response.behavior, 'allow');
    assert.deepEqual(response.updatedInput.answers, {
      'Colors?': 'red, green',
    });
  } finally {
    await session.close();
  }
});

await test('a Claude elicitation returns the accepted content', async () => {
  const requests: UserRequest[] = [];
  const { session, cwd } = await fixture((event) => {
    if (event.type !== 'request') return;
    requests.push(event.request);
    session.respond(event.request.id, {
      decision: 'accept',
      content: { project: 'witch' },
    });
  });
  try {
    assert.equal((await session.send('elicit')).status, 'completed');
    assert.equal(requests[0]?.kind, 'elicitation');
    assert.equal(requests[0]?.title, 'Which project?');
    assert.deepEqual(requests[0]?.schema, {
      type: 'object',
      properties: { project: { type: 'string' } },
    });
    assert.deepEqual(
      JSON.parse(await readFile(join(cwd, 'response.json'), 'utf8')),
      { action: 'accept', content: { project: 'witch' } },
    );
  } finally {
    await session.close();
  }
});

await test('a permission prompt the CLI withdraws leaves the queue', async () => {
  const events: AgentEvent[] = [];
  const { session } = await fixture((event) => events.push(event));
  try {
    assert.equal((await session.send('withdrawn')).status, 'completed');
    assert.deepEqual(
      events
        .map((event) => event.type)
        .filter((type) => type.startsWith('request')),
      ['request', 'request-resolved'],
    );
  } finally {
    await session.close();
  }
});

await test('a mid-turn interrupt ends the turn with the native result', async () => {
  const { seen, onEvent } = working();
  const { session } = await fixture(onEvent);
  try {
    const turn = session.send('wait');
    await within(seen, 2000, 'first output');
    await within(session.interrupt(), 2000, 'interrupt');
    assert.deepEqual(await within(turn, 2000, 'turn'), {
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
    await within(seen, 2000, 'first output');
    await within(session.interrupt(), 2000, 'interrupt');
    assert.equal(session.closed, true);
    assert.deepEqual(await turn, {
      status: 'interrupted',
      text: 'Working.',
      unread: [],
    });
    await within(exited, 1000, 'CLI exit');
  } finally {
    await session.close();
  }
});

await test('a prompt steered into a turn reaches Claude Code, and none is taken with no turn open or once the turn has its result with no familiar running', async () => {
  const { seen, onEvent } = working();
  // the fixture sends this text after the result, while the turn waits for native idle
  const awaitingIdle = Promise.withResolvers<void>();
  const { session, cwd } = await fixture((event) => {
    onEvent(event);
    if (event.type === 'text' && event.text === 'running')
      awaitingIdle.resolve();
  });
  try {
    assert.equal(await session.steer('too early'), false);
    const turn = session.send('steerable');
    await within(seen, 2000, 'first output');
    assert.equal(await session.steer('also this'), true);
    assert.equal(await session.steer('wrap up'), true);
    assert.equal((await within(turn, 2000, 'turn')).status, 'completed');
    assert.deepEqual(await jsonLines(join(cwd, 'steered.jsonl')), [
      'also this',
      'wrap up',
    ]);
    const waiting = session.send('wait for idle');
    await writeFile(join(cwd, 'allow-running'), 'yes');
    await within(awaitingIdle.promise, 2000, 'the result');
    assert.equal(await session.steer('too late'), false);
    for (const state of ['requires_action', 'idle'])
      await writeFile(join(cwd, `allow-${state}`), 'yes');
    await within(waiting, 2000, 'idle');
  } finally {
    await session.close();
  }
});

await test("a prompt sent after the turn's result while a familiar runs in the background reaches Claude Code in that turn, and none is taken once the familiar reports", async () => {
  const texts: string[] = [];
  const costs: (number | undefined)[] = [];
  const { session, cwd } = await fixture((event) => {
    if (event.type === 'text') texts.push(event.text);
    if (event.type === 'usage') costs.push(event.usage.cost);
  });
  try {
    // familiars that finished in an earlier turn stay in the session
    assert.equal((await session.send('familiars')).status, 'completed');
    let finished = false;
    const turn = session.send('background familiar').then((result) => {
      finished = true;
      return result;
    });
    // each result reports the session's running cost
    await until('the result', () => costs.includes(0.5));
    assert.equal(await session.steer('meanwhile'), true);
    await until('the answer', () => texts.includes('Answered.'));
    assert.equal(
      await readFile(join(cwd, 'steered.jsonl'), 'utf8'),
      '"meanwhile"\n',
    );
    await until('the report', () => costs.includes(1));
    assert.equal(finished, false);
    assert.equal(await session.steer('after the report'), false);
    await writeFile(join(cwd, 'allow-idle'), 'yes');
    assert.equal((await within(turn, 2000, 'turn')).status, 'completed');
  } finally {
    await session.close();
  }
});

await test("a background workflow holds the turn open for a prompt as a familiar does, until it reports, and isn't a familiar", async () => {
  const texts: string[] = [];
  const costs: (number | undefined)[] = [];
  const subagents: string[] = [];
  const { session, cwd } = await fixture((event) => {
    if (event.type === 'text') texts.push(event.text);
    if (event.type === 'usage') costs.push(event.usage.cost);
    if (event.type === 'subagent') subagents.push(event.subagent.id);
  });
  try {
    const turn = session.send('background workflow');
    await until('the result', () => costs.includes(0.25));
    assert.equal(await session.steer('meanwhile'), true);
    await until('the answer', () => texts.includes('Answered.'));
    assert.equal(
      await readFile(join(cwd, 'steered.jsonl'), 'utf8'),
      '"meanwhile"\n',
    );
    await until('the report', () => costs.includes(0.75));
    assert.equal(await session.steer('after the report'), false);
    await writeFile(join(cwd, 'allow-idle'), 'yes');
    assert.equal((await within(turn, 2000, 'turn')).status, 'completed');
    assert.deepEqual(subagents, []);
  } finally {
    await session.close();
  }
});

await test('no prompt is steered into a turn once it is interrupted or its session closes', async () => {
  const { seen, onEvent } = working();
  const { session } = await fixture(onEvent);
  try {
    const turn = session.send('steerable');
    await within(seen, 2000, 'first output');
    const interrupting = session.interrupt();
    assert.equal(await session.steer('after the interrupt'), false);
    await within(interrupting, 2000, 'interrupt');
    assert.equal((await turn).status, 'interrupted');
    const next = session.send('wait');
    const closing = session.close();
    assert.equal(await session.steer('after the close'), false);
    await within(closing, 2000, 'close');
    assert.equal((await next).status, 'failed');
  } finally {
    await session.close();
  }
});

await test('an interrupt that leaves steered prompts queued closes the session and reports only those unread', async () => {
  const { seen, onEvent } = working();
  const { session, child, cwd } = await fixture(onEvent);
  try {
    const exited = once(child, 'exit');
    const turn = session.send('steerable');
    await within(seen, 2000, 'first output');
    assert.equal(await session.steer('also this'), true);
    assert.equal(await session.steer('and this'), true);
    await until('the CLI to hold both', () =>
      readFile(join(cwd, 'steered.jsonl'), 'utf8').then(
        (text) => text.trim().split('\n').length === 2,
        () => false,
      ),
    );
    await within(session.interrupt(), 2000, 'interrupt');
    assert.equal(session.closed, true);
    assert.deepEqual(await turn, {
      status: 'interrupted',
      text: 'Working.',
      unread: ['and this'],
    });
    await within(exited, 1000, 'CLI exit');
  } finally {
    await session.close();
  }
});

await test('a CLI that exits mid-turn ends the turn only once its stderr is complete, and posts no notice', async () => {
  const { seen, onEvent } = working();
  const notices: AgentEvent[] = [];
  const { session, child } = await fixture((event) => {
    onEvent(event);
    if (event.type === 'notice') notices.push(event);
  });
  try {
    const exited = once(child, 'exit');
    let finished = false;
    const turn = session.send('crash').then((result) => {
      finished = true;
      return result;
    });
    await within(seen, 2000, 'first output');
    await within(exited, 2000, 'CLI exit');
    const deadline = Date.now() + 1000;
    while (!session.closed) {
      assert.ok(Date.now() < deadline, 'the session never closed');
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(finished, false);
    await assert.rejects(session.send('again'), /closed/);
    await within(session.interrupt(), 2000, 'interrupt');
    const result = await within(turn, 2000, 'turn');
    assert.equal(result.status, 'interrupted');
    assert.match(result.error ?? '', /fixture stderr text/);
    assert.match(result.error ?? '', /grandchild line/);
    assert.deepEqual(notices, []);
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
    await within(seen, 2000, 'first output');
    await within(exited, 2000, 'CLI exit');
    await within(session.interrupt(), 2000, 'interrupt');
    assert.equal((await within(turn, 2000, 'turn')).status, 'interrupted');
  } finally {
    await session.close();
  }
});

for (const [prompt, expected] of [
  ['execution error', { status: 'failed', text: '', error: 'tool crashed' }],
  [
    'api error',
    { status: 'failed', text: 'API Error: 500', error: 'API Error: 500' },
  ],
] as const)
  await test(`an ${prompt} result fails the turn with its error`, async () => {
    const { session } = await fixture();
    try {
      assert.deepEqual(await session.send(prompt), expected);
    } finally {
      await session.close();
    }
  });

await test('a CLI that exits cleanly before idle fails the turn with its stderr', async () => {
  const { session } = await fixture();
  try {
    const result = await within(
      session.send('quit early'),
      2000,
      'quit early turn',
    );
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
    assert.match(
      await within(notice.promise, 2000, 'exit notice'),
      /grandchild line/,
    );
  } finally {
    await session.close();
  }
});

await test("Claude tool use and its result update one tool titled by what it acts on, relative to the session's directory, a text result shows as text, an image result arrives as an image, a streamed reply ends as its full message, and a subagent's text and tools stay out of the transcript", async () => {
  const events: AgentEvent[] = [];
  const { session, cwd } = await fixture((event) => events.push(event));
  try {
    assert.equal((await session.send('tools')).status, 'completed');
    assert.deepEqual(
      events
        .filter((event) => event.type === 'tool')
        .map(({ id, title, text, done, images }) => [
          id,
          title,
          text,
          done,
          images,
        ]),
      [
        [
          'tool-1',
          'Bash  List notes  $ ls …',
          '{\n  "command": "ls\\nwc -l a.md",\n  "description": "List notes"\n}',
          false,
          undefined,
        ],
        ['tool-1', '', 'a.md', true, undefined],
        [
          'tool-2',
          'Agent  Find notes',
          '{\n  "description": "Find notes",\n  "prompt": "look"\n}',
          false,
          undefined,
        ],
        ['tool-2', '', 'Found a.md.\nRead one file.', true, undefined],
        [
          'tool-3',
          // a path under the session's directory shows relative to it, after ./ so a bare name links
          'Read  ./shot.png',
          JSON.stringify({ file_path: join(cwd, 'shot.png') }, null, 2),
          false,
          undefined,
        ],
        ['tool-3', '', '', true, ['data:image/png;base64,iVBORw==']],
      ],
    );
    const texts = events.filter((event) => event.type === 'text');
    assert.deepEqual(
      texts.map(({ text, replace }) => [text, replace]),
      [
        ['Done.', undefined],
        ['Done.', true],
      ],
    );
    assert.equal(texts[0]!.id, texts[1]!.id);
  } finally {
    await session.close();
  }
});

await test("a Claude familiar's tool calls give its latest activity, with a path under the session's directory shown relative, and its count, its last message's text is its report, and an unlisted agent's frames are ignored", async () => {
  const events: AgentEvent[] = [];
  const { session, cwd } = await fixture((event) => events.push(event));
  try {
    // without it Claude Code sends a familiar's tool calls but not its text
    assert.equal(
      JSON.parse(await readFile(join(cwd, 'initialize.json'), 'utf8'))
        .forwardSubagentText,
      true,
    );
    assert.equal((await session.send('familiar-work')).status, 'completed');
    const reader = {
      id: 'reader',
      parent: undefined,
      name: 'Read tests',
      kind: '',
      status: 'running',
      run: undefined,
    };
    assert.deepEqual(
      events.flatMap((event) =>
        event.type === 'subagent' ? [event.subagent] : [],
      ),
      [
        reader,
        {
          ...reader,
          activity: undefined,
          tools: 0,
          report: 'Reading the tests.',
        },
        {
          ...reader,
          activity: 'Read  ./a.test.ts',
          tools: 1,
          report: 'Reading the tests.',
        },
        {
          ...reader,
          activity: 'Bash  Run tests  $ pnpm test',
          tools: 2,
          report: 'Reading the tests.',
        },
        // a later message's text replaces the report
        {
          ...reader,
          activity: 'Bash  Run tests  $ pnpm test',
          tools: 2,
          report: 'All tests pass.',
        },
        // the report's second block arrives as its own frame of the same message
        {
          ...reader,
          activity: 'Bash  Run tests  $ pnpm test',
          tools: 2,
          report: 'All tests pass.\nSee a.test.ts.',
        },
        {
          ...reader,
          activity: 'Bash  Run tests  $ pnpm test',
          tools: 2,
          report: 'All tests pass.\nSee a.test.ts.',
          status: 'completed',
        },
      ],
    );
  } finally {
    await session.close();
  }
});

await test("Claude's subagent tasks report their parent, run and how they finished, its shell and ambient tasks are not subagents, and an earlier run's late start and notification are ignored", async () => {
  const events: AgentEvent[] = [];
  const { session } = await fixture((event) => events.push(event));
  try {
    assert.equal((await session.send('familiars')).status, 'completed');
    const resumed = {
      id: 'resumed',
      parent: undefined,
      name: 'Fix lint',
      kind: '',
      status: 'running',
      run: '2',
    };
    assert.deepEqual(
      events.flatMap((event) =>
        event.type === 'subagent' ? [event.subagent] : [],
      ),
      [
        {
          id: 'outer',
          parent: undefined,
          name: 'Map the code',
          kind: 'Explore',
          status: 'running',
          run: undefined,
        },
        {
          id: 'inner',
          parent: 'outer',
          name: 'Read tests',
          kind: '',
          status: 'running',
          run: undefined,
        },
        // one per run
        { ...resumed, run: '1' },
        resumed,
        { ...resumed, status: 'completed' },
        {
          id: 'inner',
          parent: 'outer',
          name: 'Read tests',
          kind: '',
          status: 'completed',
          run: undefined,
        },
        {
          id: 'outer',
          parent: undefined,
          name: 'Map the code',
          kind: 'Explore',
          status: 'failed',
          run: undefined,
        },
      ],
    );
  } finally {
    await session.close();
  }
});

await test("Claude's background shells are commands from when the live set lists them, whether started there or moved there, until their notification, and neither foreground shells nor agents are", async () => {
  const events: AgentEvent[] = [];
  const { session } = await fixture((event) => events.push(event));
  try {
    assert.equal((await session.send('brews')).status, 'completed');
    assert.deepEqual(
      events.flatMap((event) =>
        event.type === 'command' ? [event.command] : [],
      ),
      [
        { id: 'serve', description: 'Start the server', status: 'running' },
        { id: 'moved', description: 'Run tests', status: 'running' },
        { id: 'serve', description: 'Start the server', status: 'failed' },
        { id: 'moved', description: 'Run tests', status: 'stopped' },
      ],
    );
    const outer = {
      id: 'outer',
      parent: undefined,
      name: 'Map the code',
      kind: '',
      run: undefined,
    };
    // the live set's agent entries don't start or end a familiar of their own
    assert.deepEqual(
      events.flatMap((event) =>
        event.type === 'subagent' ? [event.subagent] : [],
      ),
      [
        { ...outer, status: 'running' },
        { ...outer, status: 'completed' },
      ],
    );
  } finally {
    await session.close();
  }
});

await test('a CLI that exits during initialize fails the connect without a notice', async () => {
  const events: AgentEvent[] = [];
  const { connect } = await launcher('exit-on-init');
  await assert.rejects(
    within(
      connect({ onEvent: (event) => events.push(event) }),
      3000,
      'connect',
    ),
    /init exit text/,
  );
  assert.deepEqual(events, []);
});

await test('an aborted connect rejects', async () => {
  const { children, connect } = await launcher('hang-on-init');
  const controller = new AbortController();
  const connecting = connect({ signal: controller.signal });
  controller.abort();
  try {
    await assert.rejects(within(connecting, 3000, 'connect'), /aborted/);
  } finally {
    for (const child of children) child.kill('SIGKILL');
  }
});

await test('a failed initialize reports the CLI stderr even while the CLI lives', async () => {
  const { children, connect } = await launcher('init-error');
  try {
    await assert.rejects(
      within(connect(), 3000, 'connect'),
      /init failed text/,
    );
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

await test('reports the cost from each result, and context, the 5H and 7D limits and lines once the session is idle', async () => {
  const reported: Usage[] = [];
  const { session } = await fixture((event) => {
    if (event.type === 'usage') reported.push(event.usage);
  });
  try {
    await until('the usage at connect', () => !!session.usage.limits);
    assert.equal((await session.send('hello')).status, 'completed');
    await until(
      'the usage after the turn',
      () => session.usage.lines?.added === 4,
    );
    assert.deepEqual(session.usage, {
      cost: 0.25,
      context: 12.5,
      lines: { added: 4, removed: 1 },
      limits: [
        { window: '5H', percent: 23.5, resetsAt: 2000000000 },
        { window: '7D', percent: 61 },
      ],
    });
    assert.deepEqual(reported.at(-1), session.usage);
    // each result carries the session's total so far
    assert.equal((await session.send('again')).status, 'completed');
    await until(
      'the usage after the second turn',
      () => session.usage.lines?.added === 8,
    );
    assert.equal(session.usage.cost, 0.5);
  } finally {
    await session.close();
  }
});

await test('a result that arrives with no turn open still reports the cost', async () => {
  const { session } = await fixture();
  try {
    assert.equal((await session.send('background result')).status, 'completed');
    await until('the background result', () => session.usage.cost === 0.5);
  } finally {
    await session.close();
  }
});

await test('reports the effort Claude Code says it will send', async () => {
  const { session } = await fixture(() => {}, 'init-effort');
  try {
    assert.equal(session.info.nativeEffort, undefined);
    await session.send('hello');
    assert.equal(session.info.nativeEffort, 'max');
    await session.selectModel('claude-a', 'low');
    assert.equal(session.info.nativeEffort, 'low');
  } finally {
    await session.close();
  }
});

const execute = promisify(execFile);
/** pgrep exits 1 when nothing matches. */
const running = (pattern: string) =>
  execute('pgrep', ['-f', pattern]).then(
    () => true,
    () => false,
  );
const stop = (pattern: string) =>
  execute('pkill', ['-f', pattern]).catch(() => {});

await test("a shell command runs in the session's directory as one open tool row, sends Claude nothing, and its record goes ahead of the next prompt once", async () => {
  const tools: Extract<AgentEvent, { type: 'tool' }>[] = [];
  const { session, cwd } = await fixture((event) => {
    if (event.type === 'tool') tools.push(event);
  });
  try {
    assert.deepEqual(
      await within(session.shell('pwd -P'), 3000, 'the command'),
      { status: 'completed', text: '' },
    );
    assert.equal(new Set(tools.map(({ id }) => id)).size, 1);
    assert.equal(tools[0]!.title, 'pwd -P');
    assert.equal(tools[0]!.shell, true);
    assert.equal(tools.at(-1)!.done, true);
    await assert.rejects(access(join(cwd, 'content.json')));
    await session.send('next');
    assert.deepEqual(await content(cwd), [
      {
        type: 'text',
        text: `<bash-input>pwd -P</bash-input>\n<bash-stdout>${await realpath(cwd)}\n</bash-stdout><bash-stderr></bash-stderr>`,
      },
      { type: 'text', text: 'next' },
    ]);
    await session.send('again');
    assert.equal(await content(cwd), 'again');
  } finally {
    await session.close();
  }
});

await test("a shell command refuses steering, and an interrupt kills it, ends it interrupted and keeps its record for the next prompt with the next command's", async () => {
  const output: string[] = [];
  const { session, cwd } = await fixture((event) => {
    if (event.type === 'tool') output.push(event.text);
  });
  try {
    const shell = session.shell('echo started; sleep 60.139');
    await until('the command starts', () =>
      output.join('').includes('started'),
    );
    assert.equal(await session.steer('more'), false);
    await session.interrupt();
    assert.equal(
      (await within(shell, 3000, 'the interrupted command')).status,
      'interrupted',
    );
    await until('the sleep ends', async () => !(await running('sleep 60.139')));
    assert.equal(
      (await within(session.shell('echo second'), 3000, 'the next command'))
        .status,
      'completed',
    );
    await session.send('next');
    const blocks = JSON.parse(
      await readFile(join(cwd, 'content.json'), 'utf8'),
    ) as { text: string }[];
    assert.equal(blocks.length, 3);
    assert.ok(
      blocks[0]!.text.endsWith(
        '<bash-stderr>started\n[Request interrupted by user]</bash-stderr>',
      ),
      blocks[0]!.text,
    );
    assert.equal(
      blocks[1]!.text,
      '<bash-input>echo second</bash-input>\n<bash-stdout>second\n</bash-stdout><bash-stderr></bash-stderr>',
    );
    assert.equal(blocks[2]!.text, 'next');
  } finally {
    await stop('sleep 60.139');
    await session.close();
  }
});

await test('closing the session during a shell command kills it, and the shell settles without throwing', async () => {
  const tools: Extract<AgentEvent, { type: 'tool' }>[] = [];
  const { session } = await fixture((event) => {
    if (event.type === 'tool') tools.push(event);
  });
  try {
    const shell = session.shell('sleep 60.141');
    await until('the command row', () => tools.length > 0);
    await session.close();
    await within(shell, 3000, 'the closed command');
    await until('the sleep ends', async () => !(await running('sleep 60.141')));
  } finally {
    await stop('sleep 60.141');
    if (!session.closed) await session.close();
  }
});

await test("a shell command reports its shell's pid as it starts and undefined once it ends, after the start's report settles", async () => {
  const done = Promise.withResolvers<void>();
  const texts: string[] = [];
  const reports: string[] = [];
  const { connect } = await launcher();
  const session = await connect({
    onEvent: (event) => {
      if (event.type !== 'tool') return;
      texts.push(event.text);
      if (event.done) done.resolve();
    },
    onShell: async (pid) => {
      reports.push(`report ${pid}`);
      if (pid === undefined) return;
      // throws once the shell is reaped
      process.kill(pid, 0);
      // still pending when the command ends, however fast it runs
      await done.promise;
      reports.push('settled');
    },
  });
  try {
    await within(session.shell('echo $$'), 3000, 'the command');
    const pid = Number(texts.join('').trim());
    assert.deepEqual(reports, [`report ${pid}`, 'settled', 'report undefined']);
  } finally {
    await session.close();
  }
});

await test('a shell report that rejects fails the command once it ends, without an unhandled rejection', async () => {
  const texts: string[] = [];
  const { connect } = await launcher();
  const session = await connect({
    onEvent: (event) => {
      if (event.type === 'tool') texts.push(event.text);
    },
    onShell: async (pid) => {
      if (pid !== undefined) throw new Error('no shell record');
    },
  });
  try {
    await assert.rejects(
      session.shell('sleep 0.3; echo ended'),
      /no shell record/,
    );
    assert.equal(texts.join(''), 'ended\n');
  } finally {
    await session.close();
  }
});

/** what a session reports, for the commands steered after a reply. */
function observe() {
  const costs: (number | undefined)[] = [];
  const texts: string[] = [];
  const tools: Extract<AgentEvent, { type: 'tool' }>[] = [];
  const skills: string[] = [];
  const notices: string[] = [];
  const onEvent = (event: AgentEvent) => {
    if (event.type === 'usage') costs.push(event.usage.cost);
    else if (event.type === 'text') texts.push(event.text);
    else if (event.type === 'tool') tools.push(event);
    else if (event.type === 'skills')
      skills.push(...event.skills.map(({ name }) => name));
    else if (event.type === 'notice') notices.push(event.text);
  };
  /** whether the shell row the command opened is done. */
  const ended = (command: string) => {
    const id = tools.find(({ title }) => title === command)?.id;
    return tools.some((tool) => tool.id === id && tool.done);
  };
  return { costs, texts, tools, skills, notices, onEvent, ended };
}

/** the blocks a steered command's reply goes as, its record first. */
const replyBlocks = (command: string, stdout: string) => [
  {
    type: 'text',
    text: `<bash-input>${command}</bash-input>\n<bash-stdout>${stdout}</bash-stdout><bash-stderr></bash-stderr>`,
  },
  { type: 'text', text: 'reply' },
];

const allow = (cwd: string, ...names: string[]) =>
  Promise.all(names.map((name) => writeFile(join(cwd, name), 'yes')));
const gated = 'until [ -e go ]; do sleep 0.05; done; echo held';

await test('a command steered after the result runs, refuses other prompts while it runs, then steers its record and reply', async () => {
  const seen = observe();
  const { session, cwd } = await fixture(seen.onEvent);
  try {
    const turn = session.send('background familiar');
    await until('the result', () => seen.costs.includes(0.25));
    assert.equal(await session.steer('reply', { command: gated }), true);
    await until('the command row', () =>
      seen.tools.some(({ title }) => title === gated),
    );
    assert.equal(session.replied, false);
    assert.equal(await session.steer('more'), false);
    await allow(cwd, 'go');
    const steered = join(cwd, 'steered.jsonl');
    const expected = [replyBlocks(gated, 'held\n')];
    await until('the reply', async () =>
      isDeepStrictEqual(await jsonLines(steered), expected),
    );
    await allow(cwd, 'allow-idle');
    assert.equal((await within(turn, 2000, 'turn')).status, 'completed');
    assert.deepEqual(await jsonLines(steered), expected);
  } finally {
    await session.close();
  }
});

await test("a turn whose familiar reports while a steered command runs stays open through Claude Code's idle until the command's reply is answered", async () => {
  const seen = observe();
  const { session, cwd } = await fixture(seen.onEvent);
  try {
    let finished = false;
    const turn = session.send('reporting familiar').then((result) => {
      finished = true;
      return result;
    });
    await until('the result', () => seen.costs.includes(0.25));
    assert.equal(await session.steer('reply', { command: gated }), true);
    await allow(cwd, 'allow-report', 'allow-idle');
    await until('idle', () => seen.skills.includes('after-idle'));
    assert.equal(finished, false);
    await allow(cwd, 'go');
    assert.equal((await within(turn, 3000, 'turn')).status, 'completed');
    assert.deepEqual(await content(cwd), replyBlocks(gated, 'held\n'));
  } finally {
    await session.close();
  }
});

await test("a command that ends while Claude Code answers the familiar's report sends its reply only once Claude Code is idle", async () => {
  const seen = observe();
  const { session, cwd } = await fixture(seen.onEvent);
  try {
    const turn = session.send('reporting familiar');
    await until('the result', () => seen.costs.includes(0.25));
    assert.equal(await session.steer('reply', { command: gated }), true);
    await allow(cwd, 'allow-report');
    await until('the report', () => seen.texts.includes('Reported.'));
    await allow(cwd, 'go');
    await until('the command ends', () => seen.ended(gated));
    // time for a reply sent too early to reach the fixture
    await new Promise((resolve) => setTimeout(resolve, 200));
    await allow(cwd, 'allow-idle');
    assert.equal((await within(turn, 3000, 'turn')).status, 'completed');
    assert.deepEqual(await content(cwd), replyBlocks(gated, 'held\n'));
    await assert.rejects(access(join(cwd, 'early.jsonl')));
  } finally {
    await session.close();
  }
});

await test('a command that ends while Claude Code runs again after idle sends its reply only once Claude Code is idle again', async () => {
  const seen = observe();
  const { session, cwd } = await fixture(seen.onEvent);
  try {
    const turn = session.send('reporting familiar');
    await until('the result', () => seen.costs.includes(0.25));
    assert.equal(await session.steer('reply', { command: gated }), true);
    await allow(cwd, 'allow-report', 'allow-idle');
    await until('idle', () => seen.skills.includes('after-idle'));
    await allow(cwd, 'allow-run');
    await until('the run', () => seen.texts.includes('Brewed.'));
    await allow(cwd, 'go');
    await until('the command ends', () => seen.ended(gated));
    // time for a reply sent too early to reach the fixture
    await new Promise((resolve) => setTimeout(resolve, 200));
    await allow(cwd, 'allow-rest');
    assert.equal((await within(turn, 3000, 'turn')).status, 'completed');
    assert.deepEqual(await content(cwd), replyBlocks(gated, 'held\n'));
    await assert.rejects(access(join(cwd, 'early.jsonl')));
  } finally {
    await session.close();
  }
});

await test("a reply waiting for Claude Code's idle goes once Claude Code starts another familiar", async () => {
  const seen = observe();
  const { session, cwd } = await fixture(seen.onEvent);
  try {
    const turn = session.send('reporting familiar');
    await until('the result', () => seen.costs.includes(0.25));
    assert.equal(await session.steer('reply', { command: gated }), true);
    await allow(cwd, 'allow-report');
    await until('the report', () => seen.texts.includes('Reported.'));
    await allow(cwd, 'go');
    await until('the command ends', () => seen.ended(gated));
    await allow(cwd, 'allow-second');
    await until('the reply', async () =>
      isDeepStrictEqual(await jsonLines(join(cwd, 'early.jsonl')), [
        replyBlocks(gated, 'held\n'),
      ]),
    );
    assert.equal((await within(turn, 3000, 'turn')).status, 'completed');
  } finally {
    await session.close();
  }
});

await test('an interrupt during a steered command after Claude Code is idle kills it and ends the turn interrupted, sending the idle CLI no interrupt and no reply', async () => {
  const seen = observe();
  const { session, cwd } = await fixture(seen.onEvent);
  try {
    const turn = session.send('reporting familiar');
    await until('the result', () => seen.costs.includes(0.25));
    assert.equal(
      await session.steer('reply', { command: 'sleep 60.38' }),
      true,
    );
    await until('the sleep starts', () => running('sleep 60.38'));
    await allow(cwd, 'allow-report', 'allow-idle');
    await until('idle', () => seen.skills.includes('after-idle'));
    await within(session.interrupt(), 3000, 'interrupt');
    assert.equal((await within(turn, 2000, 'turn')).status, 'interrupted');
    await assert.rejects(access(join(cwd, 'interrupts.log')));
    assert.equal(await content(cwd), 'reporting familiar');
    await until('the sleep ends', async () => !(await running('sleep 60.38')));
  } finally {
    await stop('sleep 60.38');
    await session.close();
  }
});

await test('a model change waits for the turn, unless it has replied and a familiar holds it open', async () => {
  const busy = working();
  const seen = observe();
  const { session, cwd } = await fixture((event) => {
    busy.onEvent(event);
    seen.onEvent(event);
  });
  try {
    const first = session.send('steerable');
    await within(busy.seen, 2000, 'first output');
    assert.equal(session.replied, false);
    await assert.rejects(
      session.selectModel('claude-b'),
      /Stop the current turn/,
    );
    assert.equal(await session.steer('wrap up'), true);
    await within(first, 2000, 'the first turn');
    const second = session.send('background familiar');
    await until('the result', () => seen.costs.includes(0.5));
    assert.equal(session.replied, true);
    await session.selectModel('claude-b');
    assert.equal(session.info.model, 'claude-b');
    assert.equal(await session.steer('meanwhile'), true);
    await allow(cwd, 'allow-idle');
    assert.equal((await within(second, 2000, 'turn')).status, 'completed');
  } finally {
    await session.close();
  }
});

await test("a command's reply that an interrupt leaves unread is not reported, so its command never runs again", async () => {
  const seen = observe();
  const { session, cwd } = await fixture(seen.onEvent);
  try {
    const turn = session.send('reporting familiar');
    await until('the result', () => seen.costs.includes(0.25));
    assert.equal(await session.steer('reply', { command: 'echo quick' }), true);
    await until('the reply', async () =>
      isDeepStrictEqual(await jsonLines(join(cwd, 'steered.jsonl')), [
        replyBlocks('echo quick', 'quick\n'),
      ]),
    );
    await within(session.interrupt(), 3000, 'interrupt');
    const result = await within(turn, 2000, 'turn');
    assert.equal(result.status, 'interrupted');
    assert.deepEqual(result.unread, []);
  } finally {
    await session.close();
  }
});

await test("a turn stays open while a steered command's end report is still settling", async () => {
  const seen = observe();
  const settled = Promise.withResolvers<void>();
  const { cwd, connect } = await launcher();
  const session = await connect({
    onEvent: seen.onEvent,
    onShell: async (pid) => {
      if (pid === undefined) await settled.promise;
    },
  });
  try {
    let finished = false;
    const turn = session.send('reporting familiar').then((result) => {
      finished = true;
      return result;
    });
    await until('the result', () => seen.costs.includes(0.25));
    assert.equal(
      await session.steer('reply', { command: 'echo settled' }),
      true,
    );
    await until('the command ends', () => seen.ended('echo settled'));
    await allow(cwd, 'allow-report', 'allow-idle');
    await until('idle', () => seen.skills.includes('after-idle'));
    assert.equal(finished, false);
    settled.resolve();
    assert.equal((await within(turn, 3000, 'turn')).status, 'completed');
    assert.deepEqual(
      await content(cwd),
      replyBlocks('echo settled', 'settled\n'),
    );
  } finally {
    settled.resolve();
    await session.close();
  }
});

await test('a steered command that fails posts its error and sends no reply', async () => {
  const seen = observe();
  const { cwd, connect } = await launcher();
  const session = await connect({
    onEvent: seen.onEvent,
    onShell: async (pid) => {
      if (pid !== undefined) throw new Error('no shell record');
    },
  });
  try {
    const turn = session.send('background familiar');
    await until('the result', () => seen.costs.includes(0.25));
    assert.equal(
      await session.steer('reply', { command: 'echo failed' }),
      true,
    );
    await until('the notice', () =>
      seen.notices.some((text) => /no shell record/.test(text)),
    );
    assert.equal(await session.steer('meanwhile'), true);
    await allow(cwd, 'allow-idle');
    assert.equal((await within(turn, 2000, 'turn')).status, 'completed');
    assert.equal(
      await readFile(join(cwd, 'steered.jsonl'), 'utf8'),
      '"meanwhile"\n',
    );
  } finally {
    await session.close();
  }
});

await test('a held turn fails when the CLI dies after idle, and its steered command stops', async () => {
  const seen = observe();
  const { session, cwd } = await fixture(seen.onEvent);
  try {
    const turn = session.send('reporting familiar');
    await until('the result', () => seen.costs.includes(0.25));
    assert.equal(
      await session.steer('reply', { command: 'sleep 60.39' }),
      true,
    );
    await until('the sleep starts', () => running('sleep 60.39'));
    await allow(cwd, 'allow-report', 'allow-idle');
    await until('idle', () => seen.skills.includes('after-idle'));
    await allow(cwd, 'allow-die');
    const result = await within(turn, 3000, 'turn');
    assert.equal(result.status, 'failed');
    // only end() adds the stderr tail
    assert.match(result.error ?? '', /grandchild line/);
    await until('the sleep ends', async () => !(await running('sleep 60.39')));
  } finally {
    await stop('sleep 60.39');
    await session.close();
  }
});

await test('a shell command run with no turn open keeps running when the CLI dies', async () => {
  const seen = observe();
  const { session, cwd } = await fixture(seen.onEvent);
  try {
    const turn = session.send('reporting familiar');
    await until('the result', () => seen.costs.includes(0.25));
    await allow(cwd, 'allow-report', 'allow-idle');
    assert.equal((await within(turn, 2000, 'turn')).status, 'completed');
    const shell = session.shell('sleep 1; echo done');
    await until('the command row', () =>
      seen.tools.some(({ title }) => title === 'sleep 1; echo done'),
    );
    await allow(cwd, 'allow-die');
    await until('the CLI dies', () => session.closed);
    assert.equal((await within(shell, 3000, 'command')).status, 'completed');
    assert.match(seen.tools.map(({ text }) => text).join(''), /done/);
  } finally {
    await session.close();
  }
});

await test('an interrupt while a command that ended waits for idle sends no reply', async () => {
  const seen = observe();
  const { session, cwd } = await fixture(seen.onEvent);
  try {
    const turn = session.send('reporting familiar');
    await until('the result', () => seen.costs.includes(0.25));
    assert.equal(await session.steer('reply', { command: gated }), true);
    await allow(cwd, 'allow-report');
    await until('the report', () => seen.texts.includes('Reported.'));
    await allow(cwd, 'go');
    await until('the command ends', () => seen.ended(gated));
    await within(session.interrupt(), 3000, 'interrupt');
    assert.equal((await within(turn, 2000, 'turn')).status, 'interrupted');
    await assert.rejects(access(join(cwd, 'early.jsonl')));
    assert.equal(await content(cwd), 'reporting familiar');
  } finally {
    await session.close();
  }
});

const mark = { environment: { WITCH_JOBS: '/x/jobs' }, script: '/x/jobs/env' };

/** runs `body` with another instance's mark in Witch's environment, as when Witch runs inside an agent's command. */
async function insideAnotherWitch(body: () => Promise<void>) {
  const outer = process.env.WITCH_JOBS;
  process.env.WITCH_JOBS = '/outer/jobs/1';
  try {
    await body();
  } finally {
    if (outer === undefined) delete process.env.WITCH_JOBS;
    else process.env.WITCH_JOBS = outer;
  }
}

await test("Claude Code gets the mark's script as CLAUDE_ENV_FILE, and the CLI doesn't get the mark", async () => {
  await insideAnotherWitch(async () => {
    const { envs, connect } = await launcher();
    const session = await connect({ mark });
    try {
      assert.equal(envs[0]!.CLAUDE_ENV_FILE, '/x/jobs/env');
      assert.equal(envs[0]!.WITCH_JOBS, '/outer/jobs/1');
    } finally {
      await session.close();
    }
  });
});

await test("a ! command's shell gets the mark's environment over Witch's", async () => {
  await insideAnotherWitch(async () => {
    const texts: string[] = [];
    const { connect } = await launcher();
    const session = await connect({
      mark,
      onEvent: (event) => {
        if (event.type === 'tool') texts.push(event.text);
      },
    });
    try {
      await within(
        session.shell('printf "%s|%s" "$WITCH_JOBS" "$TMPDIR"'),
        3000,
        'the command',
      );
      assert.equal(texts.join(''), `/x/jobs|${process.env.TMPDIR}`);
    } finally {
      await session.close();
    }
  });
});
