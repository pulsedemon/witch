import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as next } from 'node:timers/promises';
import type { UserRequest } from '../src/agents/types.js';
import type { CoordinationSnapshot } from '../src/core/coordination-state.js';
import type { Snapshot } from '../src/core/coordinator.js';
import { watchTerminal } from '../src/ui/terminal.js';
import {
  record,
  fixture as coordinatorFixture,
} from './fixtures/coordinator.js';

function source<T>(snapshot: T) {
  const listeners = new Set<() => void>();
  return {
    snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publish(update: Partial<T>) {
      this.snapshot = { ...this.snapshot, ...update };
      for (const listener of listeners) listener();
    },
  };
}

function fixture(initial: Partial<Snapshot> = {}) {
  const coordinator = source<Snapshot>({
    phase: 'idle',
    conversation: { ...record('first', '/project'), title: 'First task' },
    items: [],
    queue: [],
    requests: [],
    models: [],
    skills: [],
    subagents: [],
    backgroundCommands: [],
    agents: [],
    usage: {},
    ...initial,
  });
  const coordination = source<CoordinationSnapshot>({
    peers: [],
    reservations: [],
    unregistered: [],
  });
  const output: string[] = [];
  const stop = watchTerminal(coordinator, coordination, (data) =>
    output.push(data),
  );
  const notices = () =>
    output
      .filter((data) => data.startsWith('\u001b]777;'))
      .map((data) => {
        const prefix = '\u001b]777;notify;Witch;';
        assert.ok(data.startsWith(prefix));
        assert.ok(data.endsWith('\u001b\\\u0007'));
        const body = data.slice(prefix.length, -3);
        assert.doesNotMatch(body, /\p{Cc}/u);
        return body;
      });
  return { coordinator, coordination, output, stop, notices };
}

const approval: UserRequest = {
  id: 'approval',
  kind: 'approval',
  title: 'Write a file',
  detail: '/project/result.txt',
};
const question: UserRequest = {
  id: 'question',
  kind: 'question',
  title: 'Choose a color',
  detail: '',
  questions: [{ id: 'color', title: 'Color?', options: ['red', 'blue'] }],
};
const elicitation: UserRequest = {
  id: 'elicitation',
  kind: 'elicitation',
  title: 'Choose a project',
  detail: '',
  schema: { type: 'object', properties: { project: { type: 'string' } } },
};

await test('terminal titles follow claim-only updates, mutable titles and conversation ownership', (t) => {
  const { coordinator, coordination, output, stop } = fixture({
    phase: 'starting',
    conversation: undefined,
  });
  t.after(stop);
  assert.deepEqual(output, ['\u001b]2;Witch | starting\u001b\\']);
  const conversation = { ...record('first', '/project'), title: 'First task' };
  coordinator.publish({ phase: 'idle', conversation });
  assert.equal(output.at(-1), '\u001b]2;Witch | idle | First task\u001b\\');
  const before = output.length;
  coordinator.publish({ usage: { cost: 1 } });
  assert.equal(output.length, before);
  conversation.title = 'Renamed conversation';
  coordinator.publish({ usage: { cost: 2 } });
  assert.equal(
    output.at(-1),
    '\u001b]2;Witch | idle | Renamed conversation\u001b\\',
  );
  const claim = {
    id: '11111111-1111-4111-8111-111111111111',
    owner: { conversation: 'first', project: 'projects/terminal' },
    references: ['task:projects/terminal:attention'],
    summary: 'Claimed task',
    createdAt: 1,
  };
  coordination.publish({ ownClaim: claim });
  assert.equal(output.at(-1), '\u001b]2;Witch | idle | Claimed task\u001b\\');
  coordination.publish({ ownClaim: undefined });
  assert.equal(
    output.at(-1),
    '\u001b]2;Witch | idle | Renamed conversation\u001b\\',
  );
  coordination.publish({ ownClaim: claim });
  coordinator.publish({
    conversation: { ...record('second', '/project'), title: 'Second task' },
  });
  assert.equal(output.at(-1), '\u001b]2;Witch | idle | Second task\u001b\\');
});

await test('unrelated updates preserve reminder deadlines, and each next request gets its own reminder', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { coordinator, output, stop, notices } = fixture({
    phase: 'running',
    requests: [approval, question, elicitation],
  });
  t.after(stop);
  assert.equal(output[0], '\u001b]2;Witch | waiting | First task\u001b\\');
  assert.deepEqual(notices(), ['Approval required: First task']);
  t.mock.timers.tick(5000);
  coordinator.snapshot.conversation!.title = 'Current task';
  coordinator.publish({ usage: { cost: 3 } });
  t.mock.timers.tick(9999);
  assert.deepEqual(notices(), ['Approval required: First task']);
  t.mock.timers.tick(1);
  assert.deepEqual(notices(), [
    'Approval required: First task',
    'Approval required: Current task',
  ]);
  coordinator.publish({ requests: [question, elicitation] });
  assert.equal(notices().at(-1), 'Answer needed: Current task');
  coordinator.publish({ requests: [elicitation] });
  assert.equal(notices().at(-1), 'Input required: Current task');
  assert.equal(notices().length, 4);
  coordinator.publish({ requests: [] });
  assert.equal(
    output.at(-1),
    '\u001b]2;Witch | running | Current task\u001b\\',
  );
  t.mock.timers.tick(30_000);
  assert.equal(notices().length, 4);
});

await test('recovery and fatal errors repeat in view order, while ordinary idle reports stay quiet', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const recovery = {
    kind: 'pending' as const,
    paths: [],
    diff: '+pending note',
    root: '/memory',
  };
  const { coordinator, stop, notices } = fixture({
    phase: 'recovery',
    recovery,
    requests: [approval],
  });
  t.after(stop);
  assert.deepEqual(notices(), ['Approval required: First task']);
  coordinator.publish({ requests: [] });
  t.mock.timers.tick(15_000);
  assert.deepEqual(notices().slice(1), [
    'Memory recovery required: First task',
    'Memory recovery required: First task',
  ]);
  coordinator.publish({ phase: 'editing', recovery: undefined });
  t.mock.timers.tick(30_000);
  assert.equal(notices().length, 3);
  coordinator.publish({ phase: 'recovery', recovery });
  assert.equal(notices().length, 4);
  coordinator.publish({
    phase: 'error',
    recovery: undefined,
    error: 'Lost session',
  });
  t.mock.timers.tick(15_000);
  assert.deepEqual(notices().slice(4), [
    'Restart required: First task',
    'Restart required: First task',
  ]);
  coordinator.publish({ phase: 'idle', error: 'Ordinary report' });
  t.mock.timers.tick(30_000);
  assert.equal(notices().length, 6);
});

await test('terminal framing sanitizes names and preserves reasons within the UTF-8 limit', (t) => {
  const { coordinator, output, stop, notices } = fixture();
  t.after(stop);
  coordinator.publish({
    conversation: {
      ...record('first', '/project'),
      title:
        ' \u001b]2;injected\u0007Safe;\n\t\u0080task\u001b[31m\u001b[0m\u009c ',
    },
    requests: [approval],
  });
  assert.deepEqual(output.slice(-2), [
    '\u001b]2;Witch | waiting | Safe; task\u001b\\',
    '\u001b]777;notify;Witch;Approval required: Safe; task\u001b\\\u0007',
  ]);
  for (const name of ['界'.repeat(80), '🧙'.repeat(100)]) {
    coordinator.publish({ requests: [] });
    coordinator.publish({
      conversation: { ...record('first', '/project'), title: name },
      requests: [approval],
    });
    const title = output.at(-2)!.slice('\u001b]2;'.length, -2);
    const body = notices().at(-1)!;
    assert.ok(title.startsWith('Witch | waiting | '));
    assert.ok(body.startsWith('Approval required: '));
    for (const value of [title, body]) {
      assert.ok(Buffer.byteLength(value) <= 240);
      assert.equal(Buffer.from(value).toString('utf8'), value);
      assert.ok(!value.includes('\ufffd'));
      assert.ok(value.endsWith('…'));
    }
  }
  coordinator.publish({
    conversation: {
      ...record('first', '/project'),
      title: '\u001b[31m\n\u0007',
    },
  });
  assert.equal(
    output.at(-1),
    '\u001b]2;Witch | waiting | New conversation\u001b\\',
  );
});

for (const closing of [false, true])
  await test(`${closing ? 'closing' : 'explicit stop'} cancels attention without terminal I/O`, (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const { coordinator, coordination, output, stop } = fixture({
      requests: [approval],
    });
    t.after(stop);
    const before = output.slice();
    if (closing) coordinator.publish({ phase: 'closing' });
    else stop();
    stop();
    t.mock.timers.tick(30_000);
    coordinator.publish({ phase: 'running', requests: [question] });
    coordination.publish({ error: 'Peer read failed' });
    assert.deepEqual(output, before);
  });

await test('switching conversations cancels the old request timer', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { coordinator, stop, notices } = fixture({ requests: [approval] });
  t.after(stop);
  t.mock.timers.tick(10_000);
  coordinator.publish({
    conversation: { ...record('second', '/project'), title: 'Second task' },
    requests: [],
  });
  t.mock.timers.tick(30_000);
  assert.deepEqual(notices(), ['Approval required: First task']);
  coordinator.publish({ requests: [approval] });
  assert.deepEqual(notices(), [
    'Approval required: First task',
    'Approval required: Second task',
  ]);
});

await test('completion baselines existing turns and notifies once with the current claim', async (t) => {
  const { coordinator, coordination, notices, stop } = fixture({
    completedTurn: 'old',
  });
  t.after(stop);
  await next();
  assert.deepEqual(notices(), []);
  coordinator.publish({ phase: 'running', completedTurn: undefined });
  coordinator.publish({ phase: 'idle', completedTurn: 'new' });
  assert.deepEqual(notices(), []);
  coordination.publish({
    ownClaim: {
      id: '11111111-1111-4111-8111-111111111111',
      owner: { conversation: 'first', project: 'projects/terminal' },
      references: ['task:projects/terminal:attention'],
      summary: 'Current claim',
      createdAt: 1,
    },
  });
  await next();
  assert.deepEqual(notices(), ['Turn complete: Current claim']);
  coordinator.publish({ usage: { cost: 42 } });
  coordination.publish({ error: 'Peer read failed' });
  await next();
  assert.deepEqual(notices(), ['Turn complete: Current claim']);
  coordinator.publish({ phase: 'running', completedTurn: undefined });
  coordination.publish({
    ownClaim: { ...coordination.snapshot.ownClaim!, summary: '🧙'.repeat(100) },
  });
  coordinator.publish({ phase: 'idle', completedTurn: 'last' });
  await next();
  const body = notices().at(-1)!;
  assert.ok(body.startsWith('Turn complete: 🧙'));
  assert.ok(body.endsWith('…'));
  assert.ok(Buffer.byteLength(body) <= 240);
  assert.equal(Buffer.from(body).toString(), body);
  assert.ok(!body.includes('\ufffd'));
});

await test('the idle gap before a queued turn cannot announce its predecessor', async (t) => {
  const { coordinator, notices, stop } = fixture({ phase: 'running' });
  t.after(stop);
  coordinator.publish({
    phase: 'idle',
    completedTurn: 'first',
    queue: ['next'],
  });
  coordinator.publish({ queue: [] });
  coordinator.publish({ phase: 'running', completedTurn: undefined });
  await next();
  assert.deepEqual(notices(), []);
  coordinator.publish({ phase: 'idle', completedTurn: 'second' });
  await next();
  assert.deepEqual(notices(), ['Turn complete: First task']);
});

for (const condition of [
  'recovery',
  'error',
  'report',
  'closing',
  'switch',
  'stop',
] as const)
  await test(`${condition} cancels a deferred completion without later replay`, async (t) => {
    const { coordinator, notices, stop } = fixture();
    t.after(stop);
    coordinator.publish({ completedTurn: 'finished' });
    if (condition === 'recovery')
      coordinator.publish({
        phase: 'recovery',
        recovery: {
          kind: 'pending',
          paths: [],
          diff: '+note',
          root: '/memory',
        },
      });
    else if (condition === 'error')
      coordinator.publish({ phase: 'error', error: 'Session lost' });
    else if (condition === 'closing') coordinator.publish({ phase: 'closing' });
    else if (condition === 'report')
      coordinator.publish({ error: 'Idle report' });
    else if (condition === 'switch')
      coordinator.publish({
        conversation: { ...record('second', '/project'), title: 'Second task' },
        completedTurn: undefined,
      });
    else stop();
    await next();
    assert.deepEqual(
      notices().filter((body) => body.startsWith('Turn complete:')),
      [],
    );
    coordinator.publish({
      phase: 'idle',
      error: undefined,
      recovery: undefined,
    });
    await next();
    assert.deepEqual(
      notices().filter((body) => body.startsWith('Turn complete:')),
      [],
    );
  });

await test('real compaction emits no ordinary completion notification and the following turn still does', async () => {
  const f = await coordinatorFixture();
  await f.coordinator.send('seed');
  const output: string[] = [];
  const stop = watchTerminal(f.coordinator, undefined, (text) =>
    output.push(text),
  );
  try {
    await f.coordinator.compact();
    await next();
    assert.equal(f.a.compactions.length, 1);
    assert.equal(
      output.filter((text) => text.includes('Turn complete')).length,
      0,
    );
    await f.coordinator.send('following turn');
    await next();
    assert.equal(
      output.filter((text) => text.includes('Turn complete')).length,
      1,
    );
  } finally {
    stop();
    await f.coordinator.close();
  }
});
