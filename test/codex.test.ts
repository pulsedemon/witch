import assert from 'node:assert/strict';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, test } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import type { AgentEvent, Usage } from '../src/agents/types.js';
import { until, within } from './fixtures/within.js';
import {
  fixture,
  close,
  controlledFixture,
  appears,
  settled,
  commandFrame,
  turnFrame,
} from './fixtures/codex-adapter.js';

const terminals = (...entries: [string, string][]) => ({
  data: entries.map(([itemId, command], index) => ({
    itemId,
    command,
    processId: String(index + 1),
    cwd: '/fixture',
    osPid: null,
    cpuPercent: null,
    rssKb: null,
  })),
  nextCursor: null,
});

test('Codex commands become brews only after their originating turn ends', async () => {
  const f = await controlledFixture();
  try {
    const first = f.session.send('first');
    await appears(join(f.cwd, 'turn-1.json'));
    await f.emit(commandFrame('short'), commandFrame('long'));
    assert.deepEqual(f.commands(), []);
    await assert.rejects(access(join(f.cwd, 'list-1.json')), {
      code: 'ENOENT',
    });
    await f.emit(
      commandFrame('short', 'turn-1', 'native-thread', 'completed'),
      turnFrame(),
    );
    assert.equal((await within(first, 2000, 'first turn')).status, 'completed');
    await appears(join(f.cwd, 'list-1.json'));
    const second = f.session.send('second');
    await appears(join(f.cwd, 'turn-2.json'));
    await f.emit(turnFrame('turn-2'));
    assert.equal(
      (await within(second, 2000, 'second turn')).status,
      'completed',
    );
    await appears(join(f.cwd, 'list-2.json'));
    assert.deepEqual(f.commands(), []);
    await f.reply(2, { result: terminals(['long', 'run the long command']) });
    await f.reply(1, { result: terminals(['long', 'run the long command']) });
    assert.deepEqual(f.commands(), [
      {
        id: 'native-thread/long',
        description: 'run the long command',
        status: 'running',
      },
    ]);
    await f.emit(commandFrame('long', 'turn-1', 'native-thread', 'completed'));
    assert.deepEqual(
      f.commands().map(({ status }) => status),
      ['running', 'completed'],
    );
    assert.equal(f.commands()[1]!.id, f.commands()[0]!.id);
    assert.equal(f.commands()[1]!.description, 'run the long command');
  } finally {
    await close(f.session, f.cwd);
  }
});

test('Codex brew order follows command starts', async () => {
  const f = await controlledFixture();
  try {
    const sending = f.session.send('order');
    await appears(join(f.cwd, 'turn-1.json'));
    await f.emit(commandFrame('a'), commandFrame('b'), turnFrame());
    await sending;
    await f.reply(1, {
      result: terminals(['b', 'second command'], ['a', 'first command']),
    });
    assert.deepEqual(
      f.commands().map(({ description }) => description),
      ['first command', 'second command'],
    );
    const request = JSON.parse(
      await readFile(join(f.cwd, 'list-1.json'), 'utf8'),
    );
    assert.deepEqual(request.params, { threadId: 'native-thread' });
  } finally {
    await close(f.session, f.cwd);
  }
});

describe('a stale terminal list cannot revive a completed command or admit a later foreground command', () => {
  for (const stale of [true, false])
    test(stale ? 'old snapshot' : 'later snapshot', async () => {
      const f = await controlledFixture();
      try {
        const first = f.session.send('first');
        await appears(join(f.cwd, 'turn-1.json'));
        await f.emit(commandFrame('live'));
        if (stale) await f.emit(commandFrame('gone'), commandFrame('reused'));
        await f.emit(turnFrame());
        await first;
        await appears(join(f.cwd, 'list-1.json'));
        if (stale)
          await f.emit(
            commandFrame('gone', 'turn-1', 'native-thread', 'completed'),
            commandFrame('reused', 'turn-1', 'native-thread', 'completed'),
          );
        const second = f.session.send('second');
        await appears(join(f.cwd, 'turn-2.json'));
        const laterId = stale ? 'reused' : 'new';
        await f.emit(commandFrame(laterId, 'turn-2'));
        const listing: [string, string][] = [['live', 'survivor']];
        if (stale) listing.push(['gone', 'old gone'], ['reused', 'old reused']);
        else listing.push(['new', 'foreground']);
        await f.reply(1, { result: terminals(...listing) });
        assert.deepEqual(
          f.commands().map(({ description }) => description),
          ['survivor'],
        );
        await f.emit(
          commandFrame('live', 'turn-1', 'native-thread', 'completed'),
          commandFrame(laterId, 'turn-2', 'native-thread', 'completed'),
          turnFrame('turn-2'),
        );
        await second;
        assert.deepEqual(
          f.commands().map(({ status }) => status),
          ['running', 'completed'],
        );
      } finally {
        await close(f.session, f.cwd);
      }
    });
});

describe('Codex brews survive turn interruption and retain native terminal results', () => {
  for (const [turnStatus, status, exitCode, expected] of [
    ['interrupted', 'completed', 0, 'completed'],
    ['failed', 'failed', -1, 'failed'],
    ['completed', 'declined', -1, 'failed'],
    ['completed', 'failed', 7, 'failed'],
  ] as const)
    test(`${turnStatus} turn, ${status} command, exit ${exitCode}`, async () => {
      const f = await controlledFixture();
      try {
        const sending = f.session.send('status');
        await appears(join(f.cwd, 'turn-1.json'));
        await f.emit(commandFrame('command'), turnFrame('turn-1', turnStatus));
        assert.equal((await sending).status, turnStatus);
        await f.reply(1, {
          result: terminals(['command', 'surviving command']),
        });
        assert.deepEqual(
          f.commands().map(({ status }) => status),
          ['running'],
        );
        if (turnStatus === 'interrupted') {
          const later = f.session.send('later');
          await appears(join(f.cwd, 'turn-2.json'));
          await f.emit(turnFrame('turn-2', 'interrupted'));
          assert.equal((await later).status, 'interrupted');
          assert.deepEqual(
            f.commands().map(({ status }) => status),
            ['running'],
          );
        }
        await f.emit(
          commandFrame('command', 'turn-1', 'native-thread', status, exitCode),
        );
        assert.deepEqual(
          f.commands().map(({ status }) => status),
          ['running', expected],
        );
      } finally {
        await close(f.session, f.cwd);
      }
    });
});

test("a child's late command completion ends only its own brew", async () => {
  const f = await controlledFixture();
  try {
    await f.emit(
      turnFrame('old', 'inProgress', 'child-thread'),
      turnFrame('other', 'inProgress', 'grandchild-thread'),
      commandFrame('command', 'old', 'child-thread'),
      commandFrame('command', 'other', 'grandchild-thread'),
      commandFrame('unknown', 'stray', 'unknown-thread'),
      commandFrame('unknown', 'stray', 'unknown-thread', 'completed'),
      turnFrame('old', 'completed', 'child-thread'),
      turnFrame('other', 'completed', 'grandchild-thread'),
    );
    await f.reply(1, { result: terminals(['command', 'first child command']) });
    await f.reply(2, {
      result: terminals(['command', 'second child command']),
    });
    await assert.rejects(access(join(f.cwd, 'list-3.json')), {
      code: 'ENOENT',
    });
    assert.deepEqual(
      f.commands().map(({ id }) => id),
      ['child-thread/command', 'grandchild-thread/command'],
    );
    await f.emit(
      turnFrame('new', 'inProgress', 'child-thread'),
      commandFrame('command', 'old', 'child-thread', 'completed'),
    );
    assert.deepEqual(
      f.commands().map(({ id, status }) => [id, status]),
      [
        ['child-thread/command', 'running'],
        ['grandchild-thread/command', 'running'],
        ['child-thread/command', 'completed'],
      ],
    );
    await f.emit(
      commandFrame('command', 'other', 'grandchild-thread', 'failed', 7),
    );
    assert.equal(f.commands()[3]!.id, 'grandchild-thread/command');
    assert.equal(f.commands()[3]!.status, 'failed');
  } finally {
    await close(f.session, f.cwd);
  }
});

test('terminal discovery failure preserves the turn and retries at the next turn end', async () => {
  const f = await controlledFixture();
  try {
    for (let index = 1; index <= 3; index++) {
      const sending = f.session.send(`turn ${index}`);
      await appears(join(f.cwd, `turn-${index}.json`));
      if (index === 1) await f.emit(commandFrame('command'));
      await f.emit(turnFrame(`turn-${index}`));
      assert.equal((await sending).status, 'completed');
      await f.reply(
        index,
        index === 1
          ? { error: { message: 'list rejected' } }
          : {
              result:
                index === 2
                  ? { data: [{ itemId: 'command', command: 5 }] }
                  : terminals(['command', 'eventual command']),
            },
      );
      assert.equal(f.commands().length, index === 3 ? 1 : 0);
    }
    assert.equal(
      f.events.filter(
        (event) =>
          event.type === 'notice' && event.text.includes('could not list'),
      ).length,
      2,
    );
    assert.deepEqual(
      f.commands().map(({ description, status }) => [description, status]),
      [['eventual command', 'running']],
    );
  } finally {
    await close(f.session, f.cwd);
  }
});

describe('closing or losing Codex clears brews and ignores pending discovery', () => {
  for (const loss of [false, true])
    test(loss ? 'process exit' : 'close', async () => {
      const f = await controlledFixture();
      try {
        const first = f.session.send('first');
        await appears(join(f.cwd, 'turn-1.json'));
        await f.emit(commandFrame('listed'), turnFrame());
        await first;
        await f.reply(1, { result: terminals(['listed', 'listed command']) });
        const second = f.session.send('second');
        await appears(join(f.cwd, 'turn-2.json'));
        await f.emit(commandFrame('pending', 'turn-2'), turnFrame('turn-2'));
        await second;
        await appears(join(f.cwd, 'list-2.json'));
        if (loss) {
          await writeFile(join(f.cwd, 'exit'), '');
          await until('the lost session', () => f.session.closed);
        } else {
          const third = f.session.send('third');
          await appears(join(f.cwd, 'turn-3.json'));
          const closing = f.session.close();
          await appears(join(f.cwd, 'interrupt.json'));
          await f.reply(2, { result: terminals(['pending', 'late command']) });
          await writeFile(join(f.cwd, 'allow-interrupt'), '');
          await within(closing, 2000, 'closing without discovery');
          await third;
        }
        assert.deepEqual(
          f.commands().map(({ description, status }) => [description, status]),
          [
            ['listed command', 'running'],
            ['listed command', 'stopped'],
          ],
        );
        assert.equal(
          f.events.some(
            (event) =>
              event.type === 'notice' && event.text.includes('could not list'),
          ),
          false,
        );
      } finally {
        await close(f.session, f.cwd);
      }
    });
});

for (const resume of [undefined, 'native-thread']) {
  test(`${resume ? 'resumed' : 'new'} threads receive current roots and load every model page without native overrides`, async () => {
    const { session, cwd } = await fixture(undefined, { resume });
    try {
      assert.deepEqual(
        (await session.models()).map((model) => [model.id, model.efforts]),
        [
          ['model-a', ['low']],
          ['model-b', ['high']],
        ],
      );
      const request = JSON.parse(
        await readFile(join(cwd, 'connect.json'), 'utf8'),
      );
      assert.equal(request.method, resume ? 'thread/resume' : 'thread/start');
      assert.equal(request.params.threadId, resume);
      assert.deepEqual(request.params.runtimeWorkspaceRoots, [
        cwd,
        '/shared/global',
        '/shared/project',
      ]);
      assert.deepEqual(request.params.config, {});
      for (const key of [
        'baseInstructions',
        'developerInstructions',
        'sandbox',
        'permissions',
        'approvalPolicy',
        'approvalsReviewer',
      ])
        assert.equal(request.params[key], undefined);
    } finally {
      await close(session, cwd);
    }
  });
}

test("threads start with the mark in Codex's shell environment policy", async () => {
  const { session, cwd } = await fixture(undefined, {
    mark: { environment: { WITCH_JOBS: '/x/jobs' } },
  });
  try {
    const start = JSON.parse(await readFile(join(cwd, 'connect.json'), 'utf8'));
    assert.deepEqual(start.params.config, {
      'shell_environment_policy.set.WITCH_JOBS': '/x/jobs',
    });
  } finally {
    await close(session, cwd);
  }
});

test('a Codex that exits while idle posts the exit as a notice', async () => {
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

test('closing a Codex session posts no exit notice', async () => {
  const notices: AgentEvent[] = [];
  const { session, cwd } = await fixture((event) => {
    if (event.type === 'notice') notices.push(event);
  });
  await close(session, cwd);
  assert.deepEqual(notices, []);
});

test('a Codex that exits during a model change fails the change without a notice', async () => {
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

test('an aborted connect rejects', async () => {
  const controller = new AbortController();
  const connecting = fixture(() => {}, {
    mode: 'hang-on-init',
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(within(connecting, 3000, 'connect'), {
    name: 'AbortError',
    message: /aborted/,
  });
});

test('a missing stored thread fails the connect with no exit notice', async () => {
  const events: AgentEvent[] = [];
  await assert.rejects(
    fixture((event) => events.push(event), { resume: 'stored-thread' }).then(
      ({ session, cwd }) => close(session, cwd),
    ),
    /no rollout found for thread id stored-thread/,
  );
  assert.deepEqual(events, []);
});

test('a request Codex resolves itself leaves the queue before the turn ends', async () => {
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

test('an accepted permissions request grants the requested permissions for the turn', async () => {
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

test('a file change approval reaches the user and returns its decision', async () => {
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
  test(`native approval ${decision} controls the requested side effect`, async () => {
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

test('skills keep the first enabled entry per name and prefer its interface description', async () => {
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

test('a skill send names the first listed path, and a plain send names none', async () => {
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

test('a prompt steered into a turn goes to Codex for that turn, and one Codex refuses or with no turn open is left to the next turn', async () => {
  const { session, cwd } = await fixture();
  try {
    assert.equal(await session.steer('too early'), false);
    await assert.rejects(access(join(cwd, 'steer.json')));
    const turn = session.send('hold');
    await appears(join(cwd, 'prompt.json'));
    assert.equal(await session.steer('also this'), true);
    const request = JSON.parse(
      await readFile(join(cwd, 'steer.json'), 'utf8'),
    ) as { params: unknown };
    assert.deepEqual(request.params, {
      threadId: 'native-thread',
      expectedTurnId: 'turn-1',
      input: [{ type: 'text', text: 'also this', text_elements: [] }],
    });
    assert.equal(await session.steer('refused'), false);
    await writeFile(join(cwd, 'release'), 'yes');
    await within(session.interrupt(), 2000, 'interrupt');
    assert.equal((await turn).status, 'interrupted');
  } finally {
    await close(session, cwd);
  }
});

test('interrupt waits for the native turn to complete', async () => {
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

for (const prompt of ['die on interrupt', 'die after interrupt'])
  test(`a Codex that exits during an interrupt ends the turn interrupted, and the interrupt resolves (${prompt})`, async () => {
    const { session, cwd } = await fixture();
    try {
      const turn = session.send(prompt);
      await appears(join(cwd, 'prompt.json'));
      await within(session.interrupt(), 2000, 'interrupt');
      assert.equal((await within(turn, 2000, 'turn')).status, 'interrupted');
    } finally {
      await close(session, cwd);
    }
  });

test('an interrupt a running Codex refuses rejects, and the turn goes on', async () => {
  const { session, cwd } = await fixture();
  try {
    const turn = session.send('refuse interrupt');
    await appears(join(cwd, 'prompt.json'));
    await assert.rejects(
      within(session.interrupt(), 2000, 'interrupt'),
      /no active turn to interrupt/,
    );
    await writeFile(join(cwd, 'release'), 'yes');
    assert.equal((await within(turn, 2000, 'turn')).status, 'completed');
  } finally {
    await close(session, cwd);
  }
});

test('model selection waits for the settings notification', async () => {
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

test('malformed notifications post one notice per method and the turn completes', async () => {
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

test('Codex turn text keeps message order and empty replacements', async () => {
  const { session, cwd } = await fixture();
  try {
    assert.deepEqual(await session.send('turn text'), {
      status: 'completed',
      text: 'alpha final\n\nbravo tail\n\n',
    });
    assert.deepEqual(await session.send('error'), {
      status: 'failed',
      text: '',
      error: 'native error',
    });
  } finally {
    await close(session, cwd);
  }
});

test('a retried native error posts a notice, and the final one only fails the turn', async () => {
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

test('a malformed settings notification fails the model change', async () => {
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
  test(`a turn completed as ${prompt} fails only that turn`, async () => {
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

test('an unparseable native request gets an error reply and the turn continues', async () => {
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

test('an unsupported native request gets an error reply and the turn continues', async () => {
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

test("a command streams its output into one tool that completes once in the command's cwd, and the user message and reasoning show none", async () => {
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

test("Codex items are titled by what they act on, with a path under the session's directory shown relative and a path field's path named for its link, a familiar's collab call or activity under Witch's name, and a viewed image and an MCP tool's image arrive as images, not base64 text", async () => {
  const tools: Extract<AgentEvent, { type: 'tool' }>[] = [];
  const { session, cwd } = await fixture((event) => {
    if (event.type === 'tool') tools.push(event);
  });
  try {
    assert.equal((await session.send('tool-items')).status, 'completed');
    assert.deepEqual(
      tools.map(({ id, title, path, images }) => [id, title, path, images]),
      [
        ['patch-1', 'fileChange  ./a.md  b.md', undefined, undefined],
        [
          'mcp-1',
          'browser.screenshot  https://example.com',
          undefined,
          ['data:image/png;base64,iVBORw=='],
        ],
        ['mcp-2', 'files.read  ./c.txt', './c.txt', undefined],
        ['dynamic-1', 'read  ./d.txt', './d.txt', undefined],
        ['view-1', 'imageView  /shots/a.png', '/shots/a.png', ['/shots/a.png']],
        ['collab-1', 'Familiar  Review the diff …', undefined, undefined],
        ['collab-2', 'Close familiar', undefined, undefined],
        ['activity-1', 'Familiar', undefined, undefined],
      ],
    );
    assert.match(tools[1]!.text, /Captured\./);
    assert.doesNotMatch(tools[1]!.text, /iVBORw/);
    const output = JSON.parse(tools[1]!.text);
    assert.equal(output.extra, 'tool metadata');
    assert.deepEqual(output.result.content, [
      { type: 'text', text: 'Captured.' },
      {
        type: 'image',
        data: '…',
        mimeType: 'image/png',
        extra: 'image metadata',
      },
      { type: 'image', data: 42, mimeType: 'image/png' },
      { type: 'text', text: 'Other.', data: 'literal' },
      null,
      [false, 3, 'nested'],
    ]);
  } finally {
    await close(session, cwd);
  }
});

test('a Codex file change arrives as its diffs from its start, a new or deleted file as one hunk of its lines, a move without its note, and a declined change says so', async () => {
  const tools: Extract<AgentEvent, { type: 'tool' }>[] = [];
  const { session, cwd } = await fixture((event) => {
    if (event.type === 'tool') tools.push(event);
  });
  try {
    assert.equal((await session.send('file-changes')).status, 'completed');
    const patch = [
      {
        path: join(cwd, 'a.txt'),
        kind: 'update',
        hunks: [
          {
            oldStart: 3,
            newStart: 3,
            lines: [' gamma', '-delta', '+DELTA', ' epsilon'],
          },
        ],
      },
      {
        path: join(cwd, 'b.txt'),
        kind: 'add',
        hunks: [{ oldStart: 0, newStart: 1, lines: ['+new one', '+new two'] }],
      },
      {
        path: join(cwd, 'c.txt'),
        kind: 'delete',
        hunks: [
          { oldStart: 1, newStart: 0, lines: ['-remove me', '-second line'] },
        ],
      },
      {
        path: join(cwd, 'd.txt'),
        kind: 'update',
        movePath: join(cwd, 'e.txt'),
        hunks: [{ oldStart: 1, newStart: 1, lines: ['-x', '+y'] }],
      },
    ];
    assert.deepEqual(
      tools.map(({ id, text, done, diff }) => [id, text, done, diff]),
      [
        ['patch-1', '', false, patch],
        ['patch-1', '', true, patch],
        [
          'patch-2',
          'Patch declined',
          true,
          [
            {
              path: join(cwd, 'f.txt'),
              kind: 'add',
              hunks: [{ oldStart: 0, newStart: 1, lines: ['+f'] }],
            },
          ],
        ],
      ],
    );
  } finally {
    await close(session, cwd);
  }
});

test('a Codex that exits during initialize fails the connect without a notice', async () => {
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

test('a Codex MCP server that fails to start posts one notice naming it', async () => {
  const events: AgentEvent[] = [];
  const { session, cwd } = await fixture((event) => events.push(event), {
    mode: 'mcp-failed',
  });
  const notices = () => events.filter((event) => event.type === 'notice');
  try {
    await until('the MCP notices', () => notices().length >= 2);
    assert.deepEqual(notices(), [
      {
        type: 'notice',
        text: 'Codex could not start MCP server unreal: MCP client for `unreal` failed to start: handshake failed',
        transient: true,
      },
      {
        type: 'notice',
        text: 'Codex could not start MCP server auth.',
        transient: true,
      },
    ]);
  } finally {
    await close(session, cwd);
  }
});

test('a grandchild holding the native pipes cannot keep a dead turn open, and the exit posts no notice', async () => {
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

test("a model chosen without an effort keeps the requested one and never reports Codex's default as requested", async () => {
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

test('a null effort stops requesting one', async () => {
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

test("a turn after connecting with an effort requests it, not Codex's own", async () => {
  const { session, cwd } = await fixture(() => {}, { effort: 'high' });
  try {
    assert.equal((await session.send('tool')).status, 'completed');
    const prompt = JSON.parse(await readFile(join(cwd, 'prompt.json'), 'utf8'));
    assert.equal(prompt.params.effort, 'high');
  } finally {
    await close(session, cwd);
  }
});

test('a model choice that changes no native setting returns and shows the choice', async () => {
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

test("a spawned thread's tool items, not its prompt or thinking, give its familiar's latest activity, with a path under the session's directory shown relative and a familiar it spawns under Witch's name, and its count, its completed message is its report, a thread with no turn here is ignored, a restart starts without the last run's activity, count and report, and an earlier turn's late item and end are ignored", async () => {
  const events: AgentEvent[] = [];
  const { session, cwd } = await fixture((event) => events.push(event));
  try {
    assert.equal(
      (await within(session.send('familiar-work'), 3000, 'turn')).status,
      'completed',
    );
    const worker = {
      id: 'worker-thread',
      name: 'agent',
      kind: '',
      runtime: 'codex',
      status: 'running',
      run: 'worker-thread-turn',
    };
    assert.deepEqual(
      events.flatMap((event) =>
        event.type === 'subagent' ? [event.subagent] : [],
      ),
      [
        worker,
        { ...worker, activity: 'pnpm test', tools: 1 },
        { ...worker, activity: 'Familiar  Check the docs', tools: 2 },
        { ...worker, activity: 'imageView  ./a.png', tools: 3 },
        {
          ...worker,
          activity: 'imageView  ./a.png',
          tools: 3,
          report: 'Done.',
        },
        {
          ...worker,
          activity: 'imageView  ./a.png',
          tools: 3,
          report: 'Done.',
          status: 'completed',
        },
        // a restart is a new run, without the last one's activity, count and report
        { ...worker, run: 'worker-thread-turn-2' },
        // and a late item and end from the turn before it are ignored
        { ...worker, run: 'worker-thread-turn-3' },
      ],
    );
    // and what is ignored posts no notice either
    assert.deepEqual(
      events.filter(({ type }) => type === 'notice'),
      [],
    );
  } finally {
    await close(session, cwd);
  }
});

test("a spawned thread's task names its subagent under its parent with the turn as its run, its text, settings and completion stay out of the parent's turn, and a restart keeps its parent, task name and kind", async () => {
  const events: AgentEvent[] = [];
  const named = Promise.withResolvers<void>();
  const { session, cwd } = await fixture((event) => {
    events.push(event);
    if (event.type === 'subagent' && event.subagent.name === 'check defaults')
      named.resolve();
  });
  try {
    const result = await within(session.send('familiars'), 3000, 'turn');
    assert.deepEqual(
      [result.status, result.text, session.info.model],
      ['completed', 'Parent text.', 'model-a'],
    );
    await within(named.promise, 3000, 'thread reads');
    const subagents = new Map(
      events.flatMap((event) =>
        event.type === 'subagent'
          ? [[event.subagent.id, event.subagent] as const]
          : [],
      ),
    );
    assert.deepEqual(
      [...subagents.values()],
      [
        {
          id: 'child-thread',
          parent: undefined,
          name: 'inspect config',
          kind: 'explorer',
          runtime: 'codex',
          status: 'running',
          run: 'child-thread-turn',
        },
        {
          id: 'grandchild-thread',
          parent: 'child-thread',
          name: 'check defaults',
          kind: '',
          runtime: 'codex',
          status: 'stopped',
          run: 'grandchild-thread-turn',
        },
        // the reads of these fail, so they keep the defaults
        {
          id: 'failed-thread',
          name: 'agent',
          kind: '',
          runtime: 'codex',
          status: 'failed',
          run: 'failed-thread-turn',
        },
        {
          id: 'done-thread',
          name: 'agent',
          kind: '',
          runtime: 'codex',
          status: 'completed',
          run: 'done-thread-turn',
        },
        // its completion names no turn, so no run
        {
          id: 'stray-thread',
          name: 'agent',
          kind: '',
          runtime: 'codex',
          status: 'running',
        },
      ],
    );
    assert.deepEqual(
      events.flatMap((event) =>
        event.type === 'text'
          ? [event.text]
          : event.type === 'request'
            ? [`request ${event.request.id}`]
            : event.type === 'request-resolved'
              ? [`resolved ${event.id}`]
              : event.type === 'notice'
                ? [event.text.split(': ')[0]]
                : [],
      ),
      [
        'request 95',
        'resolved 95',
        "Witch could not read Codex's turn/completed notification",
        'Parent text.',
      ],
    );
    const read = events.length;
    assert.equal(
      (await within(session.send('familiar-restart'), 3000, 'restart')).status,
      'completed',
    );
    assert.deepEqual(
      events
        .slice(read)
        .flatMap((event) =>
          event.type === 'subagent' ? [event.subagent] : [],
        ),
      [
        {
          id: 'child-thread',
          name: 'inspect config',
          kind: 'explorer',
          runtime: 'codex',
          status: 'running',
          run: 'child-thread-turn-2',
        },
        {
          id: 'grandchild-thread',
          parent: 'child-thread',
          name: 'check defaults',
          kind: '',
          runtime: 'codex',
          status: 'running',
          run: 'grandchild-thread-turn-2',
        },
      ],
    );
  } finally {
    await close(session, cwd);
  }
});

test('a reroute shows the model in use, and choosing the thread model again returns', async () => {
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

test('native secret questions and MCP form answers reach their protocol consumers unchanged', async () => {
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

test("reports context, lines summed over the thread's turns and limits merged from sparse updates, leaving out other threads and limits", async () => {
  const reported: Usage[] = [];
  const { session, cwd } = await fixture((event) => {
    if (event.type === 'usage') reported.push(event.usage);
  });
  try {
    await until('the limits', () => !!session.usage.limits);
    assert.equal((await session.send('usage')).status, 'completed');
    assert.deepEqual(session.usage, {
      context: 25,
      contextWindow: 256000,
      lines: { added: 4, removed: 2 },
      limits: [
        { window: '5H', percent: 15, resetsAt: 2000000100 },
        { window: '7D', percent: 40, resetsAt: 2000500000 },
      ],
    });
    assert.deepEqual(reported.at(-1), session.usage);
    const lineUpdates = reported.flatMap(({ lines }, index) =>
      lines && lines !== reported[index - 1]?.lines ? [lines] : [],
    );
    assert.deepEqual(
      lineUpdates.map(({ added, removed }) => [added, removed]),
      [
        [1, 0],
        [2, 1],
        [4, 2],
        [3, 1],
        [1, 0],
        [0, 0],
        [2, 1],
        [4, 2],
        [4, 2],
      ],
    );
    assert.deepEqual(lineUpdates[0], { added: 1, removed: 0 });
  } finally {
    await close(session, cwd);
  }
});

test('a Codex that cannot read its limits still connects, and leaves limits out', async () => {
  const { session, cwd } = await fixture(() => {}, { mode: 'no-limits' });
  try {
    assert.deepEqual(
      (await session.models()).map(({ id }) => id),
      ['model-a', 'model-b'],
    );
    assert.deepEqual(session.usage, {});
    assert.equal(session.closed, false);
  } finally {
    await close(session, cwd);
  }
});

test('reports the effort Codex runs, its own default first and then the one a settings update makes', async () => {
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

test('a shell command runs through thread/shellCommand as its own turn and shows open, titled as typed', async () => {
  const tools: Extract<AgentEvent, { type: 'tool' }>[] = [];
  const { session, cwd } = await fixture((event) => {
    if (event.type === 'tool') tools.push(event);
  });
  try {
    assert.deepEqual(
      await within(session.shell('echo hi'), 3000, 'the command'),
      { status: 'completed', text: '' },
    );
    const request = JSON.parse(
      await readFile(join(cwd, 'shell.json'), 'utf8'),
    ) as { params: unknown };
    assert.deepEqual(request.params, {
      threadId: 'native-thread',
      command: 'echo hi',
    });
    // Codex titles the item with its shell wrapper
    assert.deepEqual(
      tools.map(({ id, title, text, done, shell }) => [
        id,
        title,
        text,
        done,
        shell,
      ]),
      [
        ['shell-1', 'echo hi', '', false, true],
        ['shell-1', '', 'hi\n', false, undefined],
        ['shell-1', 'echo hi', 'hi\n', true, true],
      ],
    );
  } finally {
    await close(session, cwd);
  }
});

test('a prompt steered while a shell command runs is refused, and an interrupt ends it by the id turn/started gave', async () => {
  const tools: Extract<AgentEvent, { type: 'tool' }>[] = [];
  const { session, cwd } = await fixture((event) => {
    if (event.type === 'tool') tools.push(event);
  });
  try {
    const shell = session.shell('hold');
    await until('the command row', () => tools.length > 0);
    assert.equal(await session.steer('more'), false);
    await assert.rejects(access(join(cwd, 'steer.json')));
    await within(session.interrupt(), 3000, 'interrupt');
    const request = JSON.parse(
      await readFile(join(cwd, 'interrupt.json'), 'utf8'),
    ) as { params: unknown };
    assert.deepEqual(request.params, {
      threadId: 'native-thread',
      turnId: 'turn-shell',
    });
    assert.equal((await shell).status, 'interrupted');
  } finally {
    await close(session, cwd);
  }
});

test('an interrupt waiting on a shell turn that never started ends when Codex exits', async () => {
  const { session, cwd } = await fixture();
  try {
    const shell = session.shell('die soon');
    await within(session.interrupt(), 3000, 'interrupt');
    assert.notEqual(
      (await within(shell, 3000, 'the command')).status,
      'completed',
    );
  } finally {
    await close(session, cwd);
  }
});

test("a refused shell command fails its turn with Codex's reason and leaves the session free", async () => {
  const { session, cwd } = await fixture();
  try {
    const refused = await within(
      session.shell('refuse'),
      3000,
      'the refused command',
    );
    assert.equal(refused.status, 'failed');
    assert.match(refused.error ?? '', /command must not be empty/);
    assert.equal(
      (await within(session.shell('echo hi'), 3000, 'the next command')).status,
      'completed',
    );
  } finally {
    await close(session, cwd);
  }
});
