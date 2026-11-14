import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { setImmediate as next } from 'node:timers/promises';
import { join } from 'node:path';
import { NotificationSchedule } from '../src/persistence/notifications.js';
import { scratch } from './fixtures/scratch.js';
import type { UserRequest } from '../src/agents/types.js';
import type { CoordinationSnapshot } from '../src/core/coordination-state.js';
import type { Snapshot } from '../src/core/snapshot.js';
import { watchTerminal } from '../src/ui/terminal.js';
import {
  record,
  unitFixture as coordinatorFixture,
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

function fixture(
  initial: Partial<Snapshot> = {},
  schedule?: NotificationSchedule,
) {
  const coordinator = source<Snapshot>({
    phase: 'idle',
    conversation: { ...record('first', '/project'), title: 'First task' },
    items: [],
    queue: [],
    commandsPending: false,
    pendingCompaction: false,
    requests: [],
    models: [],
    skills: [],
    subagents: [],
    backgroundCommands: [],
    agents: [],
    usage: {},
    accounts: {},
    latest: {},
    ...initial,
  });

  const errors: unknown[] = [];

  const reporting = Object.assign(coordinator, {
    report(error: unknown) {
      errors.push(error);

      coordinator.publish({ error: String(error) });
    },
  });

  const coordination = source<CoordinationSnapshot>({
    peers: [],
    reservations: [],
    unregistered: [],
  });

  const output: string[] = [];

  const stop = watchTerminal(
    reporting,
    coordination,
    (data) => {
      output.push(data);
    },
    schedule,
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

  return {
    coordinator: reporting,
    coordination,
    output,
    stop,
    notices,
    errors,
  };
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

test('the terminal title of an idle session reads background while a brew runs and running while the native agent runs on its own', (t) => {
  const { coordinator, output, stop } = fixture();

  t.onTestFinished(stop);

  assert.equal(output.at(-1), '\u001b]2;Witch | idle | First task\u001b\\');

  coordinator.publish({
    backgroundCommands: [
      { id: 'serve', description: 'Serve', status: 'running' },
    ],
  });

  assert.equal(
    output.at(-1),
    '\u001b]2;Witch | background | First task\u001b\\',
  );

  coordinator.publish({ nativeRunning: true });

  assert.equal(output.at(-1), '\u001b]2;Witch | running | First task\u001b\\');
});

test('terminal titles follow claim-only updates, mutable titles and conversation ownership', (t) => {
  const { coordinator, coordination, output, stop } = fixture({
    phase: 'starting',
    conversation: undefined,
  });

  t.onTestFinished(stop);

  assert.deepEqual(output, ['\u001b]2;Witch | starting\u001b\\']);

  const conversation = { ...record('first', '/project'), title: 'First task' };

  coordinator.publish({ phase: 'idle', conversation });

  assert.equal(output.at(-1), '\u001b]2;Witch | idle | First task\u001b\\');

  const before = output.length;

  coordinator.publish({ usage: { context: 1 } });

  assert.equal(output.length, before);

  conversation.title = 'Renamed conversation';

  coordinator.publish({ usage: { context: 2 } });

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

test('unrelated updates preserve reminder deadlines, and each next request gets its own reminder', (t) => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });

  const { coordinator, output, stop, notices } = fixture({
    phase: 'running',
    requests: [approval, question, elicitation],
  });

  t.onTestFinished(stop);

  assert.equal(output[0], '\u001b]2;Witch | waiting | First task\u001b\\');

  assert.deepEqual(notices(), ['Approval required: First task']);

  vi.advanceTimersByTime(5000);

  coordinator.snapshot.conversation!.title = 'Current task';

  coordinator.publish({ usage: { context: 3 } });

  vi.advanceTimersByTime(9999);

  assert.deepEqual(notices(), ['Approval required: First task']);

  vi.advanceTimersByTime(1);

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

  vi.advanceTimersByTime(30_000);

  assert.equal(notices().length, 4);
});

test('recovery and fatal errors repeat in view order, while ordinary idle reports stay quiet', (t) => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });

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

  t.onTestFinished(stop);

  assert.deepEqual(notices(), ['Approval required: First task']);

  coordinator.publish({ requests: [] });

  vi.advanceTimersByTime(15_000);

  assert.deepEqual(notices().slice(1), [
    'Memory recovery required: First task',
    'Memory recovery required: First task',
  ]);

  coordinator.publish({ phase: 'editing', recovery: undefined });

  vi.advanceTimersByTime(30_000);

  assert.equal(notices().length, 3);

  coordinator.publish({ phase: 'recovery', recovery });

  assert.equal(notices().length, 4);

  coordinator.publish({
    phase: 'error',
    recovery: undefined,
    error: 'Lost session',
  });

  vi.advanceTimersByTime(15_000);

  assert.deepEqual(notices().slice(4), [
    'Restart required: First task',
    'Restart required: First task',
  ]);

  coordinator.publish({ phase: 'idle', error: 'Ordinary report' });

  vi.advanceTimersByTime(30_000);

  assert.equal(notices().length, 6);
});

test('terminal framing sanitizes names and preserves reasons within the UTF-8 limit', (t) => {
  const { coordinator, output, stop, notices } = fixture();

  t.onTestFinished(stop);

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
  test(`${closing ? 'closing' : 'explicit stop'} cancels attention without terminal I/O`, (t) => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });

    const { coordinator, coordination, output, stop } = fixture({
      requests: [approval],
    });

    t.onTestFinished(stop);

    const before = output.slice();

    if (closing) coordinator.publish({ phase: 'closing' });
    else stop();

    stop();

    vi.advanceTimersByTime(30_000);

    coordinator.publish({ phase: 'running', requests: [question] });

    coordination.publish({ error: 'Peer read failed' });

    assert.deepEqual(output, before);
  });

test('switching conversations cancels the old request timer', (t) => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });

  const { coordinator, stop, notices } = fixture({ requests: [approval] });

  t.onTestFinished(stop);

  vi.advanceTimersByTime(10_000);

  coordinator.publish({
    conversation: { ...record('second', '/project'), title: 'Second task' },
    requests: [],
  });

  vi.advanceTimersByTime(30_000);

  assert.deepEqual(notices(), ['Approval required: First task']);

  coordinator.publish({ requests: [approval] });

  assert.deepEqual(notices(), [
    'Approval required: First task',
    'Approval required: Second task',
  ]);
});

test('completion baselines existing turns and notifies once with the current claim', async (t) => {
  const { coordinator, coordination, notices, stop } = fixture({
    completedTurn: 'old',
  });

  t.onTestFinished(stop);

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

  coordinator.publish({ usage: { context: 42 } });

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

test('the idle gap before a queued turn cannot announce its predecessor', async (t) => {
  const { coordinator, notices, stop } = fixture({ phase: 'running' });

  t.onTestFinished(stop);

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
  test(`${condition} cancels a deferred completion without later replay`, async (t) => {
    const { coordinator, notices, stop } = fixture();

    t.onTestFinished(stop);

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

test('real compaction emits no ordinary completion notification and the following turn still does', async () => {
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

async function scheduled() {
  const schedule = await NotificationSchedule.open(
    join(await scratch('witch-terminal-'), 'notifications'),
  );

  const attempts: {
    message: () => string | undefined;
    write: (data: string) => void;
    result: PromiseWithResolvers<number | undefined>;
  }[] = [];

  vi.spyOn(schedule, 'attempt').mockImplementation(
    (message: () => string | undefined, write: (data: string) => void) => {
      const result = Promise.withResolvers<number | undefined>();

      attempts.push({ message, write, result });

      return result.promise;
    },
  );

  const f = fixture({}, schedule);

  const finish = async (index: number) => {
    const attempt = attempts[index]!;
    const message = attempt.message();

    if (message !== undefined) attempt.write(message);

    attempt.result.resolve(undefined);

    await next();
  };

  const notices = () =>
    f.output
      .join('')
      .split('\u001b]777;notify;Witch;')
      .slice(1)
      .map((text) => text.split('\u001b\\', 1)[0]);

  return { ...f, schedule, attempts, finish, notices };
}

test('scheduled waits keep title and bell timing while coalescing pending reminders and reading the latest label', async (t) => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
  });

  const f = await scheduled();

  t.onTestFinished(f.stop);

  f.coordinator.publish({ phase: 'running', requests: [approval] });

  assert.equal(f.output.at(-1), '\u0007');

  assert.ok(f.output.includes('\u001b]2;Witch | waiting | First task\u001b\\'));

  assert.deepEqual(f.notices(), []);

  vi.advanceTimersByTime(15_000);

  assert.equal(f.output.filter((x) => x === '\u0007').length, 2);

  assert.equal(f.attempts.length, 1);

  f.attempts[0]!.result.resolve(1200);

  await next();

  vi.advanceTimersByTime(1199);

  assert.equal(f.attempts.length, 1);

  f.coordination.publish({
    ownClaim: {
      id: 'claim',
      owner: { conversation: 'first', project: 'project' },
      references: [],
      summary: 'Current label',
      createdAt: 0,
    },
  });

  f.coordinator.publish({ usage: { context: 2 } });

  vi.advanceTimersByTime(1);

  assert.equal(f.attempts.length, 2);

  await f.finish(1);

  assert.deepEqual(f.notices(), ['Approval required: Current label']);

  vi.advanceTimersByTime(13_800);

  assert.equal(f.attempts.length, 3);

  await f.finish(2);

  assert.deepEqual(f.notices(), [
    'Approval required: Current label',
    'Approval required: Current label',
  ]);
});

for (const action of ['response', 'switch', 'stop', 'closing'] as const)
  test(`a scheduled wait cancels in-flight reads and retry timers on ${action}`, async (t) => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });

    const f = await scheduled();

    t.onTestFinished(f.stop);

    f.coordinator.publish({ phase: 'running', requests: [approval] });

    f.attempts[0]!.result.resolve(1200);

    await next();

    if (action === 'response') f.coordinator.publish({ requests: [] });
    else if (action === 'switch')
      f.coordinator.publish({
        conversation: record('other', '/elsewhere'),
        requests: [],
      });
    else if (action === 'closing') f.coordinator.publish({ phase: 'closing' });
    else f.stop();

    const output = f.output.join('');

    vi.advanceTimersByTime(1200);

    assert.equal(f.attempts.length, 1);

    assert.equal(f.attempts[0]!.message(), undefined);

    assert.equal(f.output.join(''), output);

    assert.deepEqual(f.notices(), []);
  });

test('an old wait callback stays cancelled when the same request returns', async (t) => {
  const f = await scheduled();

  t.onTestFinished(f.stop);

  f.coordinator.publish({ requests: [approval] });

  f.coordinator.publish({ requests: [] });

  f.coordinator.publish({ requests: [approval] });

  assert.equal(f.attempts.length, 2);

  await f.finish(0);

  assert.deepEqual(f.notices(), []);

  await f.finish(1);

  assert.deepEqual(f.notices(), ['Approval required: First task']);
});

test('scheduled completion is single delivery and reconstruction does not replay it', async (t) => {
  const f = await scheduled();
  let stop: ReturnType<typeof watchTerminal> | undefined = undefined;

  t.onTestFinished(() => {
    try {
      f.stop();
    } finally {
      stop?.();
    }
  });

  f.coordinator.publish({ completedTurn: 'done' });

  await next();

  f.coordinator.publish({ usage: { context: 2 } });

  await next();

  assert.equal(f.attempts.length, 1);

  assert.equal(f.output.filter((x) => x === '\u0007').length, 1);

  await f.finish(0);

  assert.deepEqual(f.notices(), ['Turn complete: First task']);

  f.coordinator.publish({ usage: { context: 3 } });

  await next();

  assert.equal(f.attempts.length, 1);

  f.stop();

  const output: string[] = [];

  stop = watchTerminal(
    f.coordinator,
    undefined,
    (data) => {
      output.push(data);
    },
    f.schedule,
  );

  await next();

  assert.equal(f.attempts.length, 1);

  assert.equal(
    output.some((x) => x.includes(']777;') || x.includes('\u0007')),
    false,
  );

  f.coordinator.publish({ requests: [approval] });

  await f.finish(1);

  assert.ok(output.some((x) => x.includes('Approval required')));
});

for (const invalid of [
  { phase: 'running' },
  { queue: ['next'] },
  { requests: [approval] },
  { phase: 'recovery' },
  { error: 'failure' },
  { completedTurn: 'replacement' },
  { conversation: record('other', '/elsewhere') },
] satisfies Partial<Snapshot>[])
  test(`a delayed completion cancels when ${JSON.stringify(invalid)} replaces its eligible state`, async (t) => {
    const f = await scheduled();

    t.onTestFinished(f.stop);

    f.coordinator.publish({ completedTurn: 'done' });

    await next();

    f.coordinator.publish(invalid);

    assert.equal(f.attempts[0]!.message(), undefined);

    await f.finish(0);

    assert.deepEqual(f.notices(), []);
  });

test('a scheduling failure reports once without retrying output while bells and titles continue', async (t) => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
  });

  const f = await scheduled();

  t.onTestFinished(f.stop);

  f.coordinator.publish({ requests: [approval] });

  const first = f.attempts[0]!;

  first.write(first.message()!);

  first.result.reject(new Error('schedule persistence failed'));

  await next();

  assert.equal(f.errors.length, 1);

  assert.deepEqual(f.notices(), ['Approval required: First task']);

  f.coordinator.publish({ requests: [question] });

  vi.advanceTimersByTime(30_000);

  await next();

  assert.equal(f.attempts.length, 1);

  assert.equal(f.errors.length, 1);

  assert.deepEqual(f.notices(), ['Approval required: First task']);

  assert.equal(f.output.filter((x) => x === '\u0007').length, 4);

  f.coordinator.publish({ phase: 'idle', requests: [], error: undefined });

  assert.equal(f.output.at(-1), '\u001b]2;Witch | idle | First task\u001b\\');
});
