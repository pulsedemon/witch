import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { Coordinator } from '../src/core/coordinator.js';
import { Memory } from '../src/memory/memory.js';
import { StateStore } from '../src/persistence/store.js';
import {
  content,
  frameWriter,
  jsonLines,
  launcher,
} from './fixtures/claude-adapter.js';
import { readRecord } from './fixtures/coordinator.js';
import { until, within } from './fixtures/within.js';

await test('an unread shell result survives reconnect as context without rerunning its command', async () => {
  const { adapter, cwd, args } = await launcher('coordinator-reporting');
  const store = await StateStore.open(join(cwd, 'state'));
  const memory = new Memory(join(cwd, 'state', 'memory.git'));
  const coordinator = new Coordinator(store, memory, [
    { adapter, executable: '/fake/claude' },
  ]);
  const command = 'printf "once\\n" >> executions; printf "retained-output\\n"';
  const record = `<bash-input>${command}</bash-input>\n<bash-stdout>retained-output\n</bash-stdout><bash-stderr></bash-stderr>`;
  try {
    await coordinator.initialize(cwd);
    const turn = coordinator.send('reporting familiar');
    await until(
      'the first reply',
      () => coordinator.snapshot.usage.cost === 0.25,
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

async function backgroundCoordinator() {
  const { adapter, cwd } = await launcher('background');
  const store = await StateStore.open(join(cwd, 'state'));
  const memory = new Memory(join(cwd, 'state', 'memory.git'));
  const coordinator = new Coordinator(store, memory, [
    { adapter, executable: '/fake/claude' },
  ]);
  await coordinator.initialize(cwd);
  const completed: (string | undefined)[] = [];
  const unsubscribe = coordinator.subscribe(() => {
    const marker = coordinator.snapshot.completedTurn;
    if (completed.at(-1) !== marker) completed.push(marker);
  });
  const turn = coordinator.send('initial');
  await until('initial reply', () => coordinator.snapshot.usage.cost === 0.25);
  const emit = frameWriter(
    cwd,
    (name) => coordinator.snapshot.skills[0]?.name === name,
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
  await test(
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

await test('a refused steered prompt remains in the transcript', async () => {
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
