import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { Coordinator } from '../src/core/coordinator.js';
import { Memory } from '../src/memory/memory.js';
import { StateStore } from '../src/persistence/store.js';
import { content, jsonLines, launcher } from './fixtures/claude-adapter.js';
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
