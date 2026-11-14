import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentSession, TurnResult } from '../../../src/agents/types.js';
import { Coordinator } from '../../../src/core/coordinator.js';
import { StateStore } from '../../../src/persistence/store.js';
import {
  content,
  frameWriter,
  jsonLines,
  launcher,
} from '../../fixtures/claude-adapter.js';
import {
  holdSettlement,
  notices,
  readRecord,
} from '../../fixtures/coordinator.js';
import { seededMemory } from '../../fixtures/seeded-memory.js';
import { until, within } from '../../fixtures/within.js';

async function claudeCoordinator(mode: string) {
  const launched = await launcher(mode);
  const { adapter, cwd } = launched;
  const store = await StateStore.open(join(cwd, 'state'));
  const memory = await seededMemory(join(cwd, 'state', 'memory.git'));

  const coordinator = new Coordinator(store, memory, [
    { adapter, executable: '/fake/claude' },
  ]);

  return { ...launched, coordinator, memory };
}

test('a prompt Claude Code never read before an interrupt runs next, ahead of the steer behind it', async () => {
  const { coordinator, cwd, children } =
    await claudeCoordinator('hold-initial');

  const held = () => readFile(join(cwd, 'held.json'), 'utf8').catch(() => '');

  try {
    await coordinator.initialize(cwd);

    void coordinator.send('an ordinary prompt');

    await until('the held prompt', async () => (await held()).length > 0);

    await coordinator.send('a steer');

    await within(coordinator.interrupt(), 5000, 'interrupt');

    await until(
      'the rerun',
      async () =>
        children.length === 2 &&
        (await held()).includes('an ordinary prompt\\na steer'),
      200,
    );

    assert.deepEqual(
      coordinator.snapshot.items
        .filter(({ kind }) => kind === 'user')
        .slice(0, 2)
        .map(({ text, unread }) => [text, unread]),
      [
        ['an ordinary prompt', true],
        ['a steer', true],
      ],
    );
  } finally {
    await coordinator.close();
  }
});

test('a held ! command interrupted before Claude Code read it runs once', async () => {
  const { coordinator, cwd, children } =
    await claudeCoordinator('hold-initial');

  try {
    await coordinator.initialize(cwd);

    const turn = coordinator.send("!printf 'once\\n' >> executions");

    await until('the held command reply', async () =>
      (await readFile(join(cwd, 'held.json'), 'utf8').catch(() => '')).includes(
        '<bash-input>',
      ),
    );

    await within(coordinator.interrupt(), 5000, 'interrupt');

    await within(turn, 5000, 'turn');

    await delay(300);

    assert.equal(await readFile(join(cwd, 'executions'), 'utf8'), 'once\n');

    assert.equal(children.length, 1);

    assert.deepEqual(coordinator.snapshot.queue, []);
  } finally {
    await coordinator.close();
  }
});

for (const [entry, route, failures] of [
  ['initial', 'reconnect', 1],
  ['initial', 'switch', 1],
  ['steered', 'reconnect', 1],
  ['steered', 'switch', 1],
  ['initial', 'reconnect', 2],
] as const) {
  test(
    failures === 2
      ? 'a recovered command record survives another proven-unsent dispatch'
      : `an unsent command record survives failed native dispatch (${entry}, ${route})`,
    async () => {
      const { coordinator, adapter, cwd, children, args } =
        await claudeCoordinator('coordinator-reporting');

      const command =
        'printf "once\\n" >> executions; printf "retained-output\\n"';

      const record = `<bash-input>${command}</bash-input>\n<bash-stdout>retained-output\n</bash-stdout><bash-stderr></bash-stderr>`;
      const connect = adapter.connect.bind(adapter);
      const results: TurnResult[] = [];
      const writes: SDKUserMessage[][] = [];

      adapter.connect = async (options) => {
        const index = children.length;

        const session = await connect({
          ...options,
          onShell: async (pid) => {
            await options.onShell?.(pid);

            if (entry === 'steered' && index === 0 && pid === undefined)
              assert.equal(children[index]!.kill('SIGTERM'), true);
          },
        });

        const child = children[index]!;
        const write = child.stdin.write.bind(child.stdin);
        writes[index] = [];

        child.stdin.write = (...args) => {
          const frame = JSON.parse(String(args[0])) as SDKUserMessage;

          if (frame.type === 'user') writes[index]!.push(frame);

          return Reflect.apply(write, child.stdin, args) as boolean;
        };

        const send = session.send.bind(session);

        session.send = async (...input) => {
          if (entry === 'initial' && index < failures)
            assert.equal(child.kill('SIGTERM'), true);

          const result = await send(...input);

          results.push(result);

          return result;
        };

        return session;
      };

      try {
        await coordinator.initialize(cwd);

        const original = coordinator.snapshot.conversation!.id;
        let native: string | undefined;
        let turn: Promise<void>;

        if (entry === 'steered') {
          turn = coordinator.send('reporting familiar');

          await until(
            'the first reply',
            () => coordinator.snapshot.skills[0]?.name === 'result-1',
          );

          native = coordinator.snapshot.native!.id;

          await coordinator.send(`!${command}`);
        } else turn = coordinator.send(`!${command}`);

        await within(turn, 5000, 'the failed dispatch');

        const frames = [
          ...(await jsonLines(join(cwd, 'content.json'))),
          ...(await jsonLines(join(cwd, 'steered.jsonl'))),
        ];

        assert.equal(JSON.stringify(frames).includes('<bash-input>'), false);

        assert.equal(results[0]!.status, 'failed');

        assert.deepEqual(results[0]!.unreadContext, [record]);

        assert.equal(
          results[0]!.inputUnsent,
          entry === 'initial' ? true : undefined,
        );

        if (failures === 2) {
          await coordinator.send('first recovery');

          assert.equal(results[1]!.status, 'failed');

          assert.equal(results[1]!.inputUnsent, true);

          assert.equal(results[1]!.unreadContext, undefined);

          assert.deepEqual(coordinator.snapshot.queue, ['first recovery']);
        }

        assert.equal(
          writes
            .slice(0, failures)
            .flat()
            .filter((frame) =>
              JSON.stringify(frame.message.content).includes('<bash-input>'),
            ).length,
          0,
        );

        if (route === 'switch') {
          await coordinator.newConversation();

          await coordinator.send('other');

          assert.equal(
            ((await content(cwd)) as string).includes(record),
            false,
          );

          await coordinator.selectConversation(original);
        }

        await coordinator.send('next');

        if (entry === 'steered')
          assert.ok(args.at(-1)!.includes(`--resume=${native}`));
        else
          assert.equal(
            args.at(-1)!.some((arg) => arg.startsWith('--resume=')),
            false,
          );

        const next = (await content(cwd)) as string;

        assert.equal(next.split(record).length - 1, 1);

        const request = failures === 2 ? 'first recovery\nnext' : 'next';

        assert.ok(
          next.indexOf(record) < next.indexOf(`User request:\n${request}`),
        );

        assert.ok(next.endsWith(`User request:\n${request}`));

        assert.deepEqual(coordinator.snapshot.queue, []);

        assert.equal(
          coordinator.snapshot.items.filter(
            (item) => item.kind === 'user' && item.text === `!${command}`,
          ).length,
          1,
        );

        assert.equal(
          coordinator.snapshot.items.filter(
            (item) => item.kind === 'tool' && item.title === command,
          ).length,
          1,
        );

        await coordinator.send('again');

        assert.equal(((await content(cwd)) as string).includes(record), false);

        assert.equal(await readFile(join(cwd, 'executions'), 'utf8'), 'once\n');
      } finally {
        await coordinator.close();

        assert.ok(
          children.every(
            (child) => child.exitCode !== null || child.signalCode !== null,
          ),
        );
      }
    },
  );
}

for (const dispatch of [true, false])
  test(
    dispatch
      ? 'a Claude dispatch failure displays its transport cause once'
      : 'a Claude user interruption retains its result and notice',
    async () => {
      const { coordinator, adapter, cwd, children } = await claudeCoordinator(
        'coordinator-reporting',
      );

      const connect = adapter.connect.bind(adapter);
      let session: AgentSession | undefined;
      let result: TurnResult | undefined;

      adapter.connect = async (options) => {
        session = await connect(options);
        const send = session.send.bind(session);

        session.send = async (prompt, options) => {
          if (dispatch) assert.equal(children.at(-1)!.kill('SIGTERM'), true);

          result = await send(prompt, { skill: options?.skill });

          return result;
        };

        return session;
      };

      try {
        await coordinator.initialize(cwd);

        assert.equal(coordinator.snapshot.error, undefined);

        const turn = coordinator.send('reporting familiar');

        if (!dispatch) {
          await until('replied turn', () => session?.replied === true);

          await within(coordinator.interrupt(), 4000, 'interrupt');
        }

        await within(turn, 5000, 'turn');

        assert.deepEqual(
          result,
          dispatch
            ? {
                status: 'failed',
                text: '',
                error: 'Cannot write to terminated process',
                inputUnsent: true,
              }
            : { status: 'interrupted', text: 'Finished.' },
        );

        assert.deepEqual(notices(coordinator), [
          dispatch ? 'Cannot write to terminated process' : 'Turn interrupted',
        ]);

        assert.equal(coordinator.snapshot.phase, 'idle');
      } finally {
        await coordinator.close();

        assert.ok(
          children.every(
            (child) => child.exitCode !== null || child.signalCode !== null,
          ),
        );
      }
    },
  );

test('an unread shell result survives reconnect as context without rerunning its command', async () => {
  const { coordinator, cwd, args } = await claudeCoordinator(
    'coordinator-reporting',
  );

  const command = 'printf "once\\n" >> executions; printf "retained-output\\n"';
  const record = `<bash-input>${command}</bash-input>\n<bash-stdout>retained-output\n</bash-stdout><bash-stderr></bash-stderr>`;

  try {
    await coordinator.initialize(cwd);

    const turn = coordinator.send('reporting familiar');

    await until(
      'the first reply',
      () => coordinator.snapshot.skills[0]?.name === 'result-1',
    );

    const native = coordinator.snapshot.native!.id;

    await coordinator.send(`!${command}`);

    await until(
      'the held command reply',
      async () => (await jsonLines(join(cwd, 'steered.jsonl'))).length === 1,
    );

    const original = await content(cwd);

    await within(coordinator.interrupt(), 4000, 'interrupt');

    await within(turn, 4000, 'the interrupted turn');

    assert.equal(coordinator.snapshot.phase, 'idle');

    assert.deepEqual(coordinator.snapshot.queue, []);

    assert.equal(args.length, 1);

    assert.equal(await content(cwd), original);

    assert.equal(await readFile(join(cwd, 'executions'), 'utf8'), 'once\n');

    await coordinator.send('What did the command print?');

    assert.equal(args.length, 2);

    assert.ok(args[1]!.includes(`--resume=${native}`));

    const received = (await content(cwd)) as string;

    assert.equal(received.split(record).length - 1, 1);

    assert.ok(
      received.indexOf(record) <
        received.indexOf('User request:\nWhat did the command print?'),
    );

    assert.ok(received.endsWith('User request:\nWhat did the command print?'));

    assert.equal(await readFile(join(cwd, 'executions'), 'utf8'), 'once\n');

    assert.equal(
      coordinator.snapshot.items.filter(
        (item) => item.kind === 'user' && item.text === `!${command}`,
      ).length,
      1,
    );

    assert.equal(
      coordinator.snapshot.items.filter(
        (item) => item.kind === 'tool' && item.title === command,
      ).length,
      1,
    );

    assert.equal(
      coordinator.snapshot.items.filter((item) => item.kind === 'user').length,
      3,
    );

    await coordinator.send('again');

    assert.equal(((await content(cwd)) as string).includes(record), false);

    assert.equal(await readFile(join(cwd, 'executions'), 'utf8'), 'once\n');
  } finally {
    await coordinator.close();
  }
});

for (const mode of [
  'held reply',
  'completed command',
  'interrupted shell',
  'native reconnect',
]) {
  test(
    mode === 'native reconnect'
      ? 'an unsent command record survives native reconnect'
      : `an unsent command record survives conversation replacement (${mode})`,
    async () => {
      const { coordinator, adapter, cwd, args, children } =
        await claudeCoordinator('coordinator-reporting');

      const connect = adapter.connect.bind(adapter);
      let session: AgentSession;

      adapter.connect = async (options) => {
        session = await connect(options);

        if (mode === 'completed command') {
          const shell = session.shell.bind(session);

          session.shell = async (command) => {
            const result = await shell(command);

            await coordinator.interrupt();

            return result;
          };
        }

        return session;
      };

      const held = mode === 'held reply' || mode === 'native reconnect';
      const interrupted = mode === 'interrupted shell';

      const command =
        'printf "once\\n" >> executions; ' +
        (held ? 'while [ ! -f go ]; do sleep 0.01; done; ' : '') +
        'printf "retained-output\\n"' +
        (interrupted ? '; sleep 60.163' : '');

      const record =
        `<bash-input>${command}</bash-input>\n` +
        (interrupted
          ? '<bash-stdout></bash-stdout><bash-stderr>retained-output\n[Request interrupted by user]</bash-stderr>'
          : '<bash-stdout>retained-output\n</bash-stdout><bash-stderr></bash-stderr>');

      try {
        await coordinator.initialize(cwd);

        const original = coordinator.snapshot.conversation!.id;
        let turn: Promise<void>;

        if (held) {
          turn = coordinator.send('reporting familiar');

          await until(
            'the first reply',
            () => coordinator.snapshot.skills[0]?.name === 'result-1',
          );

          await coordinator.send(`!${command}`);

          await until('the shell starts', async () => {
            try {
              return (
                (await readFile(join(cwd, 'executions'), 'utf8')) === 'once\n'
              );
            } catch {
              return false;
            }
          });

          await writeFile(join(cwd, 'allow-report'), '');

          await until('the familiar completes', () =>
            coordinator.snapshot.subagents.some(
              ({ status }) => status === 'completed',
            ),
          );

          await writeFile(join(cwd, 'go'), '');

          await until('the shell completes', () =>
            coordinator.snapshot.items.some(
              (item) =>
                item.kind === 'tool' && item.title === command && item.done,
            ),
          );

          assert.deepEqual(await jsonLines(join(cwd, 'steered.jsonl')), []);

          assert.deepEqual(await jsonLines(join(cwd, 'early.jsonl')), []);

          await within(coordinator.interrupt(), 5000, 'interrupt');
        } else {
          turn = coordinator.send(`!${command}`);

          if (interrupted) {
            await until('the shell output', () =>
              coordinator.snapshot.items.some(
                (item) =>
                  item.kind === 'tool' && item.text.includes('retained-output'),
              ),
            );

            await within(coordinator.interrupt(), 5000, 'interrupt');
          }
        }

        await within(turn, 5000, 'the interrupted turn');

        assert.equal(coordinator.snapshot.phase, 'idle');

        assert.deepEqual(coordinator.snapshot.queue, []);

        const native = coordinator.snapshot.native!.id;

        if (mode === 'native reconnect') await session!.close();
        else {
          await coordinator.newConversation();

          await coordinator.send('other');

          assert.equal(
            ((await content(cwd)) as string).includes(record),
            false,
          );

          await coordinator.selectConversation(original);
        }

        await coordinator.send('next');

        if (mode === 'native reconnect') {
          assert.equal(args.length, 2);

          assert.ok(args[1]!.includes(`--resume=${native}`));
        }

        const received = (await content(cwd)) as string;

        assert.equal(received.split(record).length - 1, 1);

        assert.ok(
          received.indexOf(record) < received.indexOf('User request:\nnext'),
        );

        assert.equal(await readFile(join(cwd, 'executions'), 'utf8'), 'once\n');

        assert.deepEqual(coordinator.snapshot.queue, []);

        await coordinator.send('again');

        assert.equal(((await content(cwd)) as string).includes(record), false);

        assert.equal(await readFile(join(cwd, 'executions'), 'utf8'), 'once\n');
      } finally {
        await writeFile(join(cwd, 'go'), '');

        await coordinator.close();

        assert.ok(children.every((child) => child.exitCode === 0));
      }
    },
  );
}

test('a Claude model choice made as a familiar-held turn settles applies once', async () => {
  const { coordinator, adapter, cwd } = await claudeCoordinator(
    'coordinator-reporting',
  );

  const connect = adapter.connect.bind(adapter);
  let session: AgentSession | undefined;
  adapter.connect = async (options) => (session = await connect(options));
  let settlement: ReturnType<typeof holdSettlement> | undefined;

  try {
    await coordinator.initialize(cwd);

    settlement = holdSettlement(session!);
    const turn = coordinator.send('reporting familiar');

    await until('replied turn', () => session?.replied === true);

    assert.equal(await coordinator.refreshModels(), true);

    await writeFile(join(cwd, 'allow-report'), '');

    await until('the familiar completes', () =>
      coordinator.snapshot.subagents.some(
        ({ status }) => status === 'completed',
      ),
    );

    // the familiar no longer holds the reply open, and Claude Code hasn't reached idle
    await assert.rejects(
      coordinator.selectModel({ agent: 'claude', id: 'claude-b' }),
      { message: 'Stop the current operation first' },
    );

    await writeFile(join(cwd, 'allow-idle'), '');

    await within(settlement.entered, 5000, 'the post-turn save');

    assert.equal(coordinator.snapshot.phase, 'running');

    assert.equal(session!.replied, false);

    const choice = coordinator.selectModel({ agent: 'claude', id: 'claude-b' });

    settlement.release();

    await within(choice, 5000, 'the model choice');

    await within(turn, 5000, 'the turn');

    assert.equal(session!.info.model, 'claude-b');

    const record = await readRecord(cwd, coordinator.snapshot.conversation!.id);

    assert.equal(record.sessions.claude!.model, 'claude-b');
  } finally {
    settlement?.restore();

    await coordinator.close();
  }
});

async function backgroundCoordinator() {
  const { coordinator, memory, cwd, children } =
    await claudeCoordinator('background');

  await coordinator.initialize(cwd);

  const completed: (string | undefined)[] = [];

  const unsubscribe = coordinator.subscribe(() => {
    const marker = coordinator.snapshot.completedTurn;

    if (completed.at(-1) !== marker) completed.push(marker);
  });

  const turn = coordinator.send('initial');

  await until(
    'initial reply',
    () => coordinator.snapshot.skills[0]?.name === 'result-1',
  );

  const emit = frameWriter(
    cwd,
    (name) => coordinator.snapshot.skills[0]?.name === name,
    children[0]!,
  );

  const id = coordinator.snapshot.conversation!.id;
  const record = () => readRecord(cwd, id);

  const inputs = async () =>
    (await jsonLines(join(cwd, 'inputs.jsonl'))) as SDKUserMessage[];

  const steer = async (prompt: string) => {
    await coordinator.send(prompt);

    let uuid = '';

    await until('native follow-up', async () => {
      uuid =
        (await inputs()).find((input) => input.message.content === prompt)
          ?.uuid ?? '';

      return !!uuid;
    });

    return uuid;
  };

  return {
    coordinator,
    memory,
    cwd,
    id,
    emit,
    turn,
    record,
    inputs,
    steer,
    completed,
    unsubscribe,
  };
}

for (const interrupted of [false, true]) {
  test(
    interrupted
      ? 'interrupting that follow-up keeps its memory pending'
      : 'a steered follow-up retains memory ownership across native idle',
    async () => {
      const f = await backgroundCoordinator();

      try {
        const uuid = await f.steer('memory follow-up');
        const initial = await f.record();

        assert.ok(initial.activity);

        const activity = initial.activity.id;
        const native = f.coordinator.snapshot.native!.id;
        const priorCompleted = f.coordinator.snapshot.completedTurn;

        const accepted = () =>
          f.memory.git(f.memory.root, ['rev-parse', 'refs/heads/main']);

        const priorMain = await accepted();

        const workspace = f.memory.workspace(
          join(f.cwd, 'state', 'conversations', f.id),
          f.id,
        );

        const note = `${(await f.memory.scopePaths(f.cwd)).project}/follow-up.md`;

        await writeFile(
          join(workspace.root, note),
          'Distinct follow-up memory.\n',
        );

        const idle = {
          type: 'system',
          subtype: 'session_state_changed',
          state: 'idle',
        };

        const running = { ...idle, state: 'running' };

        const lifecycle = {
          type: 'command_lifecycle',
          command_uuid: uuid,
          state: 'started',
        };

        for (const frames of [[idle], [running, lifecycle]]) {
          await f.emit(...frames);

          await Promise.race([f.turn, delay(250)]);

          assert.equal(
            await accepted(),
            priorMain,
            'outstanding input must not publish its activity',
          );

          assert.equal(
            (
              await f.memory.git(f.memory.root, [
                'ls-tree',
                'refs/heads/main',
                '--',
                note,
              ])
            ).trim(),
            '',
          );

          assert.equal((await f.record()).activity?.id, activity);

          assert.equal(f.coordinator.snapshot.phase, 'running');

          assert.equal(f.coordinator.snapshot.completedTurn, priorCompleted);

          assert.equal(f.coordinator.snapshot.native!.id, native);

          assert.deepEqual(f.coordinator.snapshot.queue, []);
        }

        if (interrupted)
          await within(f.coordinator.interrupt(), 2000, 'follow-up interrupt');
        else
          await f.emit(
            {
              type: 'result',
              result: 'Follow-up completed.',
              user_message_uuids: [uuid],
            },
            { ...lifecycle, state: 'completed' },
            idle,
          );

        await within(f.turn, 3000, 'coordinator completion');

        assert.deepEqual(f.coordinator.snapshot.queue, []);

        assert.equal(f.coordinator.snapshot.native!.id, native);

        assert.equal(
          f.coordinator.snapshot.items.filter(
            (item) => item.kind === 'user' && item.text === 'memory follow-up',
          ).length,
          1,
        );

        assert.equal((await f.inputs()).length, 2);

        if (interrupted) {
          assert.equal(f.coordinator.snapshot.phase, 'recovery');

          assert.equal(f.coordinator.snapshot.recovery?.kind, 'pending');

          assert.equal((await f.record()).activity?.id, activity);

          assert.equal(await accepted(), priorMain);

          assert.equal(
            await readFile(join(workspace.root, note), 'utf8'),
            'Distinct follow-up memory.\n',
          );

          assert.equal(f.coordinator.snapshot.completedTurn, priorCompleted);

          assert.deepEqual(f.completed, []);
        } else {
          assert.equal(f.coordinator.snapshot.phase, 'idle');

          assert.equal((await f.record()).activity, undefined);

          assert.equal(
            await f.memory.read('refs/heads/main', note),
            'Distinct follow-up memory.\n',
          );

          assert.equal(f.coordinator.snapshot.completedTurn, activity);

          assert.deepEqual(f.completed, [activity]);
        }
      } finally {
        f.unsubscribe();

        await f.coordinator.close();
      }
    },
  );
}

test('a refused steered prompt remains in the transcript', async () => {
  const f = await backgroundCoordinator();

  try {
    const uuid = await f.steer('refused follow-up');

    await f.emit(
      { type: 'command_lifecycle', command_uuid: uuid, state: 'refused' },
      { type: 'system', subtype: 'session_state_changed', state: 'idle' },
    );

    await within(f.turn, 3000, 'refused input');

    assert.deepEqual(f.coordinator.snapshot.queue, []);

    assert.equal(
      f.coordinator.snapshot.items.filter(
        (item) => item.kind === 'user' && item.text === 'refused follow-up',
      ).length,
      1,
    );

    assert.equal((await f.inputs()).length, 2);

    assert.deepEqual(f.completed, []);
  } finally {
    f.unsubscribe();

    await f.coordinator.close();
  }
});
