import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { access, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
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
  const adapter = new ClaudeAdapter((options) => {
    assert.ok(options.args.some((arg) => arg.includes('user,project,local')));
    assert.equal(options.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS, '1');
    args.push(options.args);
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
  return { cwd, children, args, connect };
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
  const content = async () =>
    JSON.parse(await readFile(join(cwd, 'content.json'), 'utf8')) as unknown;
  try {
    await session.send('context', { name: 'review', args: 'main' });
    assert.deepEqual(await content(), [
      { type: 'text', text: 'context' },
      { type: 'text', text: '/review main' },
    ]);
    await session.send('plain');
    assert.equal(await content(), 'plain');
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
      .map((line) => JSON.parse(line) as unknown);
    assert.deepEqual(payloads, [{ effortLevel: 'high' }]);
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
    assert.deepEqual(
      (await readFile(join(cwd, 'steered.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as unknown),
      ['also this', 'wrap up'],
    );
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
    const turn = session.send('background familiar');
    // each result reports the session's running cost
    await until('the result', () => costs.includes(0.5));
    assert.equal(await session.steer('meanwhile'), true);
    await until('the answer', () => texts.includes('Answered.'));
    assert.equal(
      await readFile(join(cwd, 'steered.jsonl'), 'utf8'),
      '"meanwhile"\n',
    );
    await until('the report', () => texts.includes('Reported.'));
    assert.equal(await session.steer('after the report'), false);
    await writeFile(join(cwd, 'allow-idle'), 'yes');
    assert.equal((await within(turn, 2000, 'turn')).status, 'completed');
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
  const content = async () =>
    JSON.parse(await readFile(join(cwd, 'content.json'), 'utf8')) as unknown;
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
    assert.deepEqual(await content(), [
      {
        type: 'text',
        text: `<bash-input>pwd -P</bash-input>\n<bash-stdout>${await realpath(cwd)}\n</bash-stdout><bash-stderr></bash-stderr>`,
      },
      { type: 'text', text: 'next' },
    ]);
    await session.send('again');
    assert.equal(await content(), 'again');
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
