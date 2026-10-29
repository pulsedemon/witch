import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, test } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { ranCommand } from '../src/core/prompts.js';
import { Coordinator } from '../src/core/coordinator.js';
import type { DisplayItem } from '../src/core/state.js';
import { ConversationStore, StateStore } from '../src/persistence/store.js';
import type { FixtureAgent } from './fixtures/agent.js';
import { TurnGate } from './fixtures/agent.js';
import { fixture, readRecord, turns } from './fixtures/coordinator.js';
import { passThrough } from './fixtures/git.js';
import type { GitHook } from './fixtures/git.js';
import { until, within } from './fixtures/within.js';

test('a tool row keeps the path its title shows and its expanded title through its result and a reopen', async () => {
  const { coordinator, a, reopen } = await fixture();
  let reopened: Coordinator | undefined;
  const title = 'Read  ./shot one.png';
  const row = (items: readonly DisplayItem[]) => {
    const item = items.find((item) => item.title === title);
    return [item?.path, item?.expandedTitle];
  };
  const kept = ['./shot one.png', 'Read (native)  ./shot one.png'];
  try {
    await coordinator.send('first');
    const { onEvent } = a.sessions.at(-1)!.options;
    onEvent({
      type: 'tool',
      id: 'read',
      title,
      path: './shot one.png',
      expandedTitle: 'Read (native)  ./shot one.png',
      text: '',
      done: false,
    });
    onEvent({ type: 'tool', id: 'read', title: '', text: '', done: true });
    assert.deepEqual(row(coordinator.snapshot.items), kept);
    await coordinator.close();
    reopened = await reopen();
    assert.deepEqual(row(reopened.snapshot.items), kept);
  } finally {
    await coordinator.close();
    await reopened?.close();
  }
});

test('an unfinished tool keeps its original row through idle and later turns', async () => {
  const { coordinator, a, reopen } = await fixture();
  const first = new TurnGate();
  const second = new TurnGate();
  let reopened: Coordinator | undefined;
  const emit = (id: string, text: string, done: boolean, append = false) =>
    a.sessions.at(-1)!.options.onEvent({
      type: 'tool',
      id,
      title: id,
      text,
      done,
      append,
    });
  const rows = () =>
    coordinator.snapshot.items.filter(({ title }) => title === 'command');
  try {
    a.gate = first;
    const firstTurn = coordinator.send('first');
    await within(first.entered, 2000, 'the first turn');
    emit('command', 'start\n', false);
    const originalId = rows()[0]!.id;
    first.open();
    await firstTurn;
    emit('command', 'between\n', false, true);
    assert.equal(rows().length, 1);
    assert.equal(rows()[0]!.id, originalId);
    assert.equal(rows()[0]!.text, 'start\nbetween\n');
    assert.equal(rows()[0]!.done, false);

    a.gate = second;
    const secondTurn = coordinator.send('second');
    await within(second.entered, 2000, 'the second turn');
    emit('other', 'other\n', false);
    emit('command', 'start\nbetween\nend\n', true);
    assert.equal(rows().length, 1);
    assert.equal(rows()[0]!.id, originalId);
    assert.equal(rows()[0]!.text, 'start\nbetween\nend\n');
    assert.equal(rows()[0]!.done, true);
    const other = coordinator.snapshot.items.find(
      ({ title }) => title === 'other',
    )!;
    assert.equal(other.text, 'other\n');
    assert.equal(other.done, false);
    second.open();
    await secondTurn;
    await coordinator.close();
    reopened = await reopen();
    const saved = reopened.snapshot.items.filter(
      ({ title }) => title === 'command',
    );
    assert.equal(saved.length, 1);
    assert.equal(saved[0]!.id, originalId);
    assert.equal(saved[0]!.text, 'start\nbetween\nend\n');
    assert.equal(saved[0]!.done, true);
  } finally {
    first.open();
    second.open();
    await coordinator.close();
    await reopened?.close();
  }
});

test('completed tool IDs and new native connections get their own rows', async () => {
  const { coordinator, a } = await fixture();
  const gates = [new TurnGate(), new TurnGate(), new TurnGate()];
  const emit = (id: string, text: string, done: boolean) =>
    a.sessions.at(-1)!.options.onEvent({
      type: 'tool',
      id,
      title: id,
      text,
      done,
    });
  const rows = (title: string) =>
    coordinator.snapshot.items.filter((row) => row.title === title);
  try {
    const conversation = coordinator.snapshot.conversation!.id;
    a.gate = gates[0]!;
    const first = coordinator.send('first');
    await within(gates[0]!.entered, 2000, 'the first turn');
    emit('reused', 'first', false);
    emit('reused', 'first complete', true);
    const completedId = rows('reused')[0]!.id;
    gates[0]!.open();
    await first;

    a.gate = gates[1]!;
    const second = coordinator.send('second');
    await within(gates[1]!.entered, 2000, 'the second turn');
    emit('reused', 'second', false);
    emit('unfinished', 'old connection', false);
    const unfinishedId = rows('unfinished')[0]!.id;
    assert.deepEqual(
      rows('reused').map(({ text, done }) => [text, done]),
      [
        ['first complete', true],
        ['second', false],
      ],
    );
    assert.notEqual(rows('reused')[1]!.id, completedId);
    gates[1]!.open();
    await second;
    await coordinator.newConversation();
    await coordinator.selectConversation(conversation);

    a.gate = gates[2]!;
    const third = coordinator.send('third');
    await within(gates[2]!.entered, 2000, 'the reconnected turn');
    emit('unfinished', 'new connection', false);
    assert.deepEqual(
      rows('unfinished').map(({ text, done }) => [text, done]),
      [
        ['old connection', false],
        ['new connection', false],
      ],
    );
    assert.equal(rows('unfinished')[0]!.id, unfinishedId);
    assert.notEqual(rows('unfinished')[1]!.id, unfinishedId);
    gates[2]!.open();
    await third;
  } finally {
    for (const gate of gates) gate.open();
    await coordinator.close();
  }
});

/** holds the snapshot's note listing until released. a turn takes a snapshot only after memory moves. */
function holdSnapshot(hook: { current: GitHook }) {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  hook.current = async (command, run) => {
    if (command[0] === 'ls-tree' && command[1] === '-r') {
      hook.current = passThrough;
      entered.resolve();
      await release.promise;
    }
    return run();
  };
  return { entered: entered.promise, release: () => release.resolve() };
}

const savedCommand =
  '<bash-input>already-ran</bash-input>\n<bash-stdout>saved-output</bash-stdout><bash-stderr></bash-stderr>';

async function recoverCommandContext(
  coordinator: Coordinator,
  agent: FixtureAgent,
  via: 'turn' | 'disconnect' = 'turn',
) {
  const session = agent.sessions.at(-1)!.session;
  if (via === 'disconnect') {
    const pending = [savedCommand];
    session.takeUnreadContext = () => pending.splice(0);
    const id = coordinator.snapshot.conversation!.id;
    await coordinator.newConversation();
    await coordinator.selectConversation(id);
    return;
  }
  const send = session.send;
  session.send = async () => ({
    status: 'interrupted',
    text: '',
    unreadContext: [savedCommand],
  });
  try {
    await coordinator.send('seed');
  } finally {
    session.send = send;
  }
}

test('pending command context stays with its conversation', async () => {
  const { coordinator, a } = await fixture();
  try {
    await recoverCommandContext(coordinator, a);
    const id = coordinator.snapshot.conversation!.id;
    await coordinator.newConversation();
    await coordinator.send('other');
    assert.equal(a.inputs.at(-1)!.context!.includes(savedCommand), false);
    await coordinator.selectConversation(id);
    await coordinator.send('original');
    assert.equal(a.inputs.at(-1)!.context!.split(savedCommand).length - 1, 1);
    await coordinator.send('again');
    assert.equal(a.inputs.at(-1)!.context, undefined);
  } finally {
    await coordinator.close();
  }
});

for (const identical of [false, true]) {
  test(`disconnect appends local records to recovered conversation context (${identical ? 'identical records' : 'distinct records'})`, async () => {
    const { coordinator, a } = await fixture();
    const localCommand = identical
      ? savedCommand
      : '<bash-input>also-ran</bash-input>\n<bash-stdout>later-output</bash-stdout><bash-stderr></bash-stderr>';
    try {
      await recoverCommandContext(coordinator, a);
      const pending = [localCommand];
      a.sessions.at(-1)!.session.takeUnreadContext = () => pending.splice(0);
      const id = coordinator.snapshot.conversation!.id;
      await coordinator.newConversation();
      await coordinator.send('other');
      assert.equal(a.inputs.at(-1)!.context!.includes('<bash-input>'), false);
      await coordinator.selectConversation(id);
      await coordinator.send('original');
      const received = a.inputs.at(-1)!.context!;
      assert.equal(received.split(savedCommand).length - 1, identical ? 2 : 1);
      if (!identical) {
        assert.equal(received.split(localCommand).length - 1, 1);
        assert.ok(
          received.indexOf(savedCommand) < received.indexOf(localCommand),
        );
      }
      await coordinator.send('again');
      assert.equal(a.inputs.at(-1)!.context, undefined);
    } finally {
      await coordinator.close();
    }
  });
}

test('a failed close preserves outgoing command context', async () => {
  const { coordinator, a } = await fixture();
  try {
    const pending = [savedCommand];
    a.sessions.at(-1)!.session.takeUnreadContext = () => pending.splice(0);
    const id = coordinator.snapshot.conversation!.id;
    a.failClose = true;
    await coordinator.newConversation();
    assert.match(coordinator.snapshot.error ?? '', /Close failed/);
    a.failClose = false;
    await coordinator.send('other');
    assert.equal(a.inputs.at(-1)!.context!.includes(savedCommand), false);
    await coordinator.selectConversation(id);
    await coordinator.send('original');
    assert.equal(a.inputs.at(-1)!.context!.split(savedCommand).length - 1, 1);
    await coordinator.send('again');
    assert.equal(a.inputs.at(-1)!.context, undefined);
  } finally {
    a.failClose = false;
    await coordinator.close();
  }
});

describe('pending command context waits until a prompt is dispatched', () => {
  for (const via of ['turn', 'disconnect'] as const) {
    for (const failure of ['connect', 'snapshot', 'shell']) {
      test(`${via}: ${failure}`, async () => {
        const { coordinator, a, hook } = await fixture(undefined, (a) => {
          a.skills = [{ name: 'review', description: 'Review' }];
        });
        try {
          await recoverCommandContext(coordinator, a, via);
          const before = a.inputs.length;
          if (failure === 'connect') {
            await a.sessions.at(-1)!.session.close();
            a.failConnect = true;
            await coordinator.send('blocked');
            assert.deepEqual(coordinator.unqueue(), ['blocked']);
            a.failConnect = false;
          } else if (failure === 'snapshot') {
            const snapshot = holdSnapshot(hook);
            const sending = coordinator.send('blocked');
            try {
              await within(snapshot.entered, 3000, 'the snapshot');
              await coordinator.interrupt();
            } finally {
              snapshot.release();
            }
            await within(sending, 3000, 'the cancelled send');
            assert.deepEqual(coordinator.unqueue(), ['blocked']);
          } else {
            a.failNext = true;
            await coordinator.send('!fails');
            assert.deepEqual(a.shells, ['fails']);
          }
          assert.equal(a.inputs.length, before);
          const next = failure === 'connect' ? '/review now' : 'fresh';
          await coordinator.send(next);
          const received = a.inputs.at(-1)!;
          assert.equal(received.context!.split(savedCommand).length - 1, 1);
          assert.equal(received.prompt, next);
          if (failure === 'connect')
            assert.deepEqual(received.skill, { name: 'review', args: 'now' });
          await coordinator.send('again');
          assert.equal(a.inputs.at(-1)!.context, undefined);
        } finally {
          await coordinator.close();
        }
      });
    }
  }
});

test('an interrupt during the memory snapshot delivers nothing and leaves the prompt queued', async () => {
  const { coordinator, a, hook } = await fixture();
  try {
    await coordinator.send('remember-port');
    const before = a.inputs.length;
    const snapshot = holdSnapshot(hook);
    const sending = coordinator.send('Second');
    await within(snapshot.entered, 2000, 'the snapshot');
    await coordinator.interrupt();
    snapshot.release();
    await within(sending, 2000, 'the send');
    assert.deepEqual(coordinator.snapshot.queue, ['Second']);
    assert.equal(a.inputs.length, before);
  } finally {
    await coordinator.close();
  }
});

test('a connect failure leaves the prompt queued, and the next prompt sends both, a line each, and clears the error', async () => {
  const { coordinator, a } = await fixture(undefined, (a) => {
    a.failConnect = true;
  });
  try {
    await coordinator.send('Start');
    assert.deepEqual(coordinator.snapshot.queue, ['Start']);
    assert.match(coordinator.snapshot.error ?? '', /Destination unavailable/);
    a.failConnect = false;
    await coordinator.send('Again');
    assert.deepEqual(coordinator.snapshot.queue, []);
    assert.match(a.inputs.at(-1)!.prompt, /^Start\nAgain$/);
    assert.equal(coordinator.snapshot.error, undefined);
  } finally {
    await coordinator.close();
  }
});

describe('an interrupted initial reconnect leaves the prompt queued without an error', () => {
  for (const abort of [true, false])
    test(
      abort ? 'adapter rejects' : 'adapter connects after interrupt',
      async () => {
        const { coordinator, a } = await fixture(undefined, (a) => {
          a.failConnect = true;
        });
        const connecting = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        try {
          a.failConnect = false;
          a.beforeConnect = (options) => {
            if (abort)
              options.signal?.addEventListener('abort', () =>
                release.reject(
                  new DOMException('Connect aborted', 'AbortError'),
                ),
              );
            connecting.resolve();
            return release.promise;
          };
          const sending = coordinator.send('Queued');
          await within(connecting.promise, 2000, 'the reconnect');
          await coordinator.interrupt();
          release.resolve();
          await within(sending, 2000, 'the send');
          assert.equal(coordinator.snapshot.phase, 'idle');
          assert.equal(coordinator.snapshot.error, undefined);
          assert.deepEqual(coordinator.snapshot.queue, ['Queued']);
          assert.equal(a.inputs.length, 0);
        } finally {
          release.resolve();
          await coordinator.close();
        }
      },
    );
});

describe('an unrelated initial reconnect failure remains visible', () => {
  for (const interrupt of [true, false])
    test(
      interrupt ? 'ordinary failure after interrupt' : 'unsolicited abort',
      async () => {
        const { coordinator, a } = await fixture(undefined, (a) => {
          a.failConnect = true;
        });
        const connecting = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const failure = interrupt
          ? new Error('connection storage failed')
          : new DOMException('Connection aborted', 'AbortError');
        try {
          a.failConnect = false;
          a.beforeConnect = async () => {
            connecting.resolve();
            await release.promise;
            throw failure;
          };
          const sending = coordinator.send('Queued');
          await within(connecting.promise, 2000, 'the reconnect');
          if (interrupt) await coordinator.interrupt();
          release.resolve();
          await within(sending, 2000, 'the send');
          assert.equal(coordinator.snapshot.phase, 'idle');
          assert.equal(coordinator.snapshot.error, failure.message);
          assert.deepEqual(coordinator.snapshot.queue, ['Queued']);
          assert.equal(a.inputs.length, 0);
        } finally {
          release.resolve();
          await coordinator.close();
        }
      },
    );
});

test('a blank prompt starts no turn', async () => {
  const { coordinator, a } = await fixture();
  try {
    await coordinator.send(' \n');
    assert.deepEqual(coordinator.snapshot.queue, []);
    assert.deepEqual(a.inputs, []);
  } finally {
    await coordinator.close();
  }
});

test('a turn keeps the job watch active until it ends', async () => {
  const { coordinator, active } = await fixture();
  try {
    // the launch is active and idle is not
    assert.deepEqual(active, [true, false]);
    await coordinator.send('first');
    assert.deepEqual(active, [true, false, true, false]);
  } finally {
    await coordinator.close();
  }
});

test('a session that closes during the snapshot receives nothing', async () => {
  const { coordinator, a, hook } = await fixture();
  try {
    await coordinator.send('remember-port');
    const before = a.inputs.length;
    const snapshot = holdSnapshot(hook);
    const sending = coordinator.send('Second');
    await within(snapshot.entered, 2000, 'the snapshot');
    await a.sessions.at(-1)!.session.close();
    snapshot.release();
    await within(sending, 2000, 'the send');
    assert.deepEqual(coordinator.snapshot.queue, ['Second']);
    assert.equal(a.inputs.length, before);
    assert.ok(
      !coordinator.snapshot.items.some(
        (item) => item.kind === 'user' && item.text === 'Second',
      ),
    );
  } finally {
    await coordinator.close();
  }
});

test('Ctrl+C during the save before sending reaches the agent', async () => {
  const { coordinator, a, hook } = await fixture();
  const gate = new TurnGate();
  const save = ConversationStore.prototype.save;
  const held = Promise.withResolvers<void>();
  try {
    await coordinator.send('remember-port');
    a.gate = gate;
    let armed = false;
    hook.current = async (command, run) => {
      if (command[0] === 'ls-tree' && command[1] === '-r') {
        hook.current = passThrough;
        armed = true;
      }
      return run();
    };
    ConversationStore.prototype.save = function (record) {
      if (!armed) return save.call(this, record);
      armed = false;
      return held.promise.then(() => save.call(this, record));
    };
    const sending = coordinator.send('Second');
    await within(gate.entered, 2000, 'the gated turn');
    await coordinator.interrupt();
    assert.equal(
      (await within(gate.result, 2000, 'the turn result')).status,
      'interrupted',
    );
    held.resolve();
    await sending;
    assert.deepEqual(coordinator.snapshot.queue, []);
  } finally {
    ConversationStore.prototype.save = save;
    held.resolve();
    gate.open();
    await coordinator.close();
  }
});

test('a failure after the agent has the prompt still counts as delivered', async () => {
  const { coordinator } = await fixture();
  try {
    await coordinator.send('symlink-note');
    assert.deepEqual(coordinator.snapshot.queue, []);
    assert.match(coordinator.snapshot.error ?? '', /regular file/);
  } finally {
    await coordinator.close();
  }
});

test('a spell, a native command and prompts sent during a turn join it in order and show at once, the spell and command with their calls', async () => {
  const { coordinator, a } = await fixture(undefined, (a) => {
    a.skills = [
      { name: 'review', description: 'Review changes' },
      { name: 'context', description: 'Context', builtin: true },
    ];
  });
  const gate = new TurnGate();
  const prompts = ['/review now', '/context', 'One', 'Two'];
  try {
    a.gate = gate;
    const sending = coordinator.send('Start');
    await within(gate.entered, 2000, 'the gated turn');
    for (const prompt of prompts) await coordinator.send(prompt);
    assert.deepEqual(a.steers, prompts);
    assert.deepEqual(a.skillSteers, [
      { name: 'review', args: 'now' },
      { name: 'context', args: '' },
    ]);
    assert.deepEqual(
      coordinator.snapshot.items
        .filter(({ kind }) => kind === 'user')
        .map(({ text }) => text),
      ['Start', ...prompts],
    );
    assert.deepEqual(coordinator.snapshot.queue, []);
    gate.open();
    await within(sending, 2000, 'the turn');
    assert.deepEqual(turns(a), [['Start', undefined]]);
  } finally {
    gate.open();
    await coordinator.close();
  }
});

test('a queued prompt taken back never runs', async () => {
  const { coordinator, a } = await fixture(undefined, (a) => {
    a.skills = [{ name: 'review', description: 'Review changes' }];
  });
  const gate = new TurnGate();
  try {
    a.gate = gate;
    const sending = coordinator.send('Start');
    await within(gate.entered, 2000, 'the gated turn');
    a.refuseSteer = true;
    await coordinator.send('/review now');
    assert.deepEqual(coordinator.unqueue(), ['/review now']);
    assert.deepEqual(coordinator.snapshot.queue, []);
    gate.open();
    await within(sending, 2000, 'the turn');
    assert.equal(a.inputs.length, 1);
  } finally {
    gate.open();
    await coordinator.close();
  }
});

test('steered prompts an interrupt leaves unread go as the next turn, ahead of what was queued', async () => {
  const { coordinator, a } = await fixture(undefined, (a) => {
    a.skills = [{ name: 'review', description: 'Review changes' }];
  });
  const gate = new TurnGate();
  try {
    a.gate = gate;
    a.unreadOnInterrupt = true;
    a.refuseSkillSteer = true;
    const sending = coordinator.send('Start');
    await within(gate.entered, 2000, 'the gated turn');
    await coordinator.send('Also this');
    await coordinator.send('/review');
    await coordinator.interrupt();
    gate.open();
    await within(sending, 2000, 'the next turns');
    assert.equal((await gate.result).status, 'interrupted');
    assert.deepEqual(
      a.inputs.map(({ prompt }) => prompt),
      ['Start', 'Also this', '/review'],
    );
  } finally {
    gate.open();
    await coordinator.close();
  }
});

for (const [name, prompt, prepare] of [
  [
    'a prompt the turn refuses',
    'Later',
    async (_coordinator: Coordinator, a: FixtureAgent) => {
      a.refuseSteer = true;
    },
  ],
  [
    'a prompt sent after an interrupt',
    'Later',
    async (coordinator: Coordinator, a: FixtureAgent) => {
      // the turn runs on after the interrupt, as a Codex turn does until Codex completes it
      a.failInterrupt = true;
      await assert.rejects(coordinator.interrupt(), /Interrupt failed/);
      a.failInterrupt = false;
    },
  ],
] as const)
  test(`${name} waits in the queue, unseen until it goes as the next turn`, async () => {
    const { coordinator, a } = await fixture();
    const gate = new TurnGate();
    try {
      a.gate = gate;
      const sending = coordinator.send('Start');
      await within(gate.entered, 2000, 'the gated turn');
      await prepare(coordinator, a);
      await coordinator.send(prompt);
      assert.deepEqual(a.steers, []);
      assert.deepEqual(coordinator.snapshot.queue, [prompt]);
      assert.ok(
        !coordinator.snapshot.items.some(({ text }) => text === prompt),
      );
      gate.open();
      await within(sending, 2000, 'the queued turn');
      assert.deepEqual(turns(a), [
        ['Start', undefined],
        [prompt, undefined],
      ]);
    } finally {
      gate.open();
      await coordinator.close();
    }
  });

test('with steers refused, prompts queued ahead of a spell go as one turn, then the spell alone, then the prompts after it', async () => {
  const { coordinator, a } = await fixture(undefined, (a) => {
    a.skills = [{ name: 'review', description: 'Review changes' }];
  });
  const gate = new TurnGate();
  try {
    a.gate = gate;
    a.refuseSteer = true;
    const sending = coordinator.send('Start');
    await within(gate.entered, 2000, 'the gated turn');
    for (const prompt of ['One', 'Two', '/review now', 'Three'])
      await coordinator.send(prompt);
    gate.open();
    await within(sending, 2000, 'the queued turns');
    assert.deepEqual(turns(a), [
      ['Start', undefined],
      ['One\nTwo', undefined],
      ['/review now', { name: 'review', args: 'now' }],
      ['Three', undefined],
    ]);
  } finally {
    gate.open();
    await coordinator.close();
  }
});

test('a report after a queued turn stays on screen, and the prompts after it wait', async () => {
  const { coordinator, a, hook } = await fixture(undefined, (a) => {
    a.skills = [{ name: 'review', description: 'Review changes' }];
  });
  const gate = new TurnGate();
  try {
    a.gate = gate;
    a.refuseSteer = true;
    hook.current = async (command, run) => {
      if (command[0] !== 'update-ref') return run();
      hook.current = passThrough;
      return { stdout: Buffer.alloc(0), stderr: 'cannot lock ref', code: 1 };
    };
    const sending = coordinator.send('Start');
    await within(gate.entered, 2000, 'the gated turn');
    await coordinator.send('remember-port');
    await coordinator.send('/review');
    gate.open();
    await within(sending, 2000, 'the queued turns');
    coordinator.notice('desktop failed', undefined, false);
    assert.equal(coordinator.snapshot.items.at(-1)?.text, 'desktop failed');
    assert.equal(coordinator.snapshot.phase, 'idle');
    assert.match(coordinator.snapshot.error ?? '', /cannot lock ref/);
    assert.deepEqual(coordinator.snapshot.queue, ['/review']);
    assert.deepEqual(turns(a), [
      ['Start', undefined],
      ['remember-port', undefined],
    ]);
  } finally {
    gate.open();
    await coordinator.close();
  }
});

test('prompts sent together steer or queue in the order sent', async () => {
  const { coordinator, a } = await fixture();
  const gate = new TurnGate();
  try {
    a.gate = gate;
    const sending = coordinator.send('Start');
    await within(gate.entered, 2000, 'the gated turn');
    const { session } = a.sessions.at(-1)!;
    const steer = session.steer.bind(session);
    let first = true;
    // only the first is refused, so the second queues by its place behind it
    session.steer = async (...args) => {
      if (!first) return steer(...args);
      first = false;
      return false;
    };
    await Promise.all([
      coordinator.send('/review now'),
      coordinator.send('One'),
    ]);
    assert.deepEqual(a.steers, []);
    assert.deepEqual(coordinator.snapshot.queue, ['/review now', 'One']);
    gate.open();
    await within(sending, 2000, 'the queued turn');
    assert.deepEqual(turns(a), [
      ['Start', undefined],
      ['/review now\nOne', undefined],
    ]);
  } finally {
    gate.open();
    await coordinator.close();
  }
});

test('a spell a failed connect leaves queued still goes alone once the agent connects, ahead of what was queued behind it', async () => {
  const { coordinator, a } = await fixture(undefined, (a) => {
    a.skills = [{ name: 'review', description: 'Review changes' }];
    a.failConnect = true;
  });
  try {
    await coordinator.send('/review now');
    await coordinator.send('One');
    assert.deepEqual(coordinator.snapshot.queue, ['/review now', 'One']);
    assert.deepEqual(coordinator.snapshot.skills, []);
    a.failConnect = false;
    await coordinator.send('Two');
    assert.deepEqual(turns(a), [
      ['/review now', { name: 'review', args: 'now' }],
      ['One\nTwo', undefined],
    ]);
  } finally {
    await coordinator.close();
  }
});

test('a refusal reported before a conversation opens sets the error', async () => {
  const { coordinator: original, root, memory, a } = await fixture();
  await original.close();
  const coordinator = new Coordinator(
    await StateStore.open(join(root, 'state')),
    memory,
    [{ adapter: a, executable: 'a' }],
  );
  try {
    const refusal = await coordinator
      .newConversation()
      .catch((error: unknown) => error);
    coordinator.report(refusal);
    assert.equal(
      coordinator.snapshot.error,
      'Stop the current operation first',
    );
  } finally {
    await coordinator.close();
  }
});

test('a prompt sent while the launch connects goes once the load ends', async () => {
  const { coordinator: original, root, project, memory, a } = await fixture();
  await original.close();
  const coordinator = new Coordinator(
    await StateStore.open(join(root, 'state')),
    memory,
    [{ adapter: a, executable: 'a' }],
  );
  const connecting = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  a.beforeConnect = async () => {
    connecting.resolve();
    await release.promise;
  };
  try {
    const initializing = coordinator.initialize(project);
    await within(connecting.promise, 2000, 'the launch connect');
    await coordinator.send('Early');
    assert.deepEqual(coordinator.snapshot.queue, ['Early']);
    release.resolve();
    await initializing;
    await until('the early prompt', () =>
      a.inputs.some(({ prompt }) => prompt === 'Early'),
    );
  } finally {
    release.resolve();
    await coordinator.close();
  }
});

test('a prompt sent while a switch opens the next conversation is refused, so it never runs there', async () => {
  const { coordinator, a } = await fixture();
  try {
    const switching = coordinator.newConversation();
    await assert.rejects(coordinator.send('Leak'), /next conversation/);
    await switching;
    await delay(60);
    assert.deepEqual(a.inputs, []);
    assert.deepEqual(coordinator.snapshot.queue, []);
  } finally {
    await coordinator.close();
  }
});

test('a failed turn leaves what was queued behind it for the composer instead of running it', async () => {
  const { coordinator, a } = await fixture();
  const gate = new TurnGate();
  try {
    a.gate = gate;
    a.failNext = true;
    a.refuseSteer = true;
    const sending = coordinator.send('Start');
    await within(gate.entered, 2000, 'the gated turn');
    await coordinator.send('/review');
    gate.open();
    await sending;
    await delay(60);
    assert.equal(coordinator.snapshot.phase, 'idle');
    assert.deepEqual(coordinator.snapshot.queue, ['/review']);
    assert.deepEqual(
      a.inputs.map(({ prompt }) => prompt),
      ['Start'],
    );
  } finally {
    gate.open();
    await coordinator.close();
  }
});

test('a prompt whose steer is refused after a failed turn has ended stays for the composer, and one sent at idle still runs', async () => {
  const { coordinator, a } = await fixture();
  const gate = new TurnGate();
  try {
    a.gate = gate;
    a.failNext = true;
    const sending = coordinator.send('Start');
    await within(gate.entered, 2000, 'the gated turn');
    const refusal = Promise.withResolvers<void>();
    a.sessions.at(-1)!.session.steer = async () => {
      await refusal.promise;
      return false;
    };
    const steering = coordinator.send('Follow up');
    gate.open();
    await sending;
    refusal.resolve();
    await steering;
    await delay(60);
    assert.deepEqual(coordinator.snapshot.queue, ['Follow up']);
    assert.equal(a.inputs.length, 1);
    coordinator.unqueue();
    await coordinator.send('Retry');
    assert.deepEqual(
      a.inputs.map(({ prompt }) => prompt),
      ['Start', 'Retry'],
    );
  } finally {
    gate.open();
    await coordinator.close();
  }
});

test('a failed handoff continuation leaves what was queued during the switch for the composer', async () => {
  const { coordinator, a, b } = await fixture();
  const gate = new TurnGate();
  try {
    a.interruptNext = true;
    await coordinator.send('Start');
    b.gate = gate;
    b.failNext = true;
    const switching = coordinator.selectModel({ agent: 'b', id: 'b-model' });
    await within(gate.entered, 2000, 'the continuation');
    await coordinator.send('/review');
    gate.open();
    await switching;
    await delay(60);
    assert.equal(coordinator.snapshot.conversation!.agent, 'b');
    assert.equal(coordinator.snapshot.phase, 'idle');
    assert.deepEqual(coordinator.snapshot.queue, ['/review']);
    assert.equal(b.inputs.length, 1);
  } finally {
    gate.open();
    await coordinator.close();
  }
});

test('a prompt sent just before a switch stays queued for its conversation, so the switch is refused', async () => {
  const { coordinator, a } = await fixture();
  try {
    const { id } = coordinator.snapshot.conversation!;
    const sending = coordinator.send('Stay');
    await assert.rejects(coordinator.newConversation(), /still queued/);
    await sending;
    await delay(60);
    assert.equal(coordinator.snapshot.conversation!.id, id);
    assert.deepEqual(coordinator.snapshot.queue, ['Stay']);
    assert.deepEqual(a.inputs, []);
  } finally {
    await coordinator.close();
  }
});

test('a conversation switch is refused while prompts are queued, which wait with their report showing', async () => {
  const { coordinator, a } = await fixture(undefined, (a) => {
    a.failConnect = true;
  });
  try {
    await coordinator.send('Start');
    const { id } = coordinator.snapshot.conversation!;
    a.failConnect = false;
    await assert.rejects(coordinator.newConversation(), /still queued/);
    await delay(60);
    assert.equal(coordinator.snapshot.conversation!.id, id);
    assert.match(coordinator.snapshot.error ?? '', /still queued/);
    assert.deepEqual(coordinator.snapshot.queue, ['Start']);
    assert.deepEqual(a.inputs, []);
  } finally {
    await coordinator.close();
  }
});

for (const inputUnsent of [true, undefined]) {
  test(`failed input delivery ${inputUnsent ? 'preserves the original queue batch' : 'does not replay an uncertain submission'}`, async () => {
    const { coordinator, a } = await fixture();
    const submitted: string[] = [];
    a.sessions[0]!.session.send = async (prompt) => {
      submitted.push(prompt);
      return {
        status: 'failed',
        text: '',
        error: 'Input delivery failed',
        ...(inputUnsent ? { inputUnsent } : {}),
      };
    };
    try {
      await coordinator.send('first 17');
      assert.deepEqual(
        coordinator.snapshot.queue,
        inputUnsent ? ['first 17'] : [],
      );
      await coordinator.send('second 29');
      assert.deepEqual(submitted, [
        'first 17',
        inputUnsent ? 'first 17\nsecond 29' : 'second 29',
      ]);
      assert.deepEqual(
        coordinator.snapshot.queue,
        inputUnsent ? ['first 17', 'second 29'] : [],
      );
    } finally {
      await coordinator.close();
    }
  });
}

test('an unsent follow-up prompt never reruns an executed command', async () => {
  const { coordinator, a } = await fixture();
  const session = a.sessions[0]!.session;
  const send = session.send.bind(session);
  session.send = async () => ({
    status: 'failed',
    text: '',
    error: 'Input delivery failed',
    inputUnsent: true,
  });
  try {
    await coordinator.send('!echo once');
    assert.deepEqual(a.shells, ['echo once']);
    assert.deepEqual(coordinator.snapshot.queue, []);
    session.send = send;
    await coordinator.send('followup 29');
    assert.deepEqual(a.shells, ['echo once']);
    assert.deepEqual(
      a.inputs.map(({ prompt }) => prompt),
      ['followup 29'],
    );
  } finally {
    await coordinator.close();
  }
});

test('a ! prompt runs its command, then a turn that sends the prompt as typed and says it ran, and its open row survives a reopen', async () => {
  const { coordinator, a, reopen } = await fixture();
  try {
    await coordinator.send('!git status');
    assert.deepEqual(a.shells, ['git status']);
    assert.equal(a.inputs.length, 1);
    assert.equal(a.inputs[0]!.prompt, '!git status');
    assert.ok(a.inputs[0]!.context!.includes(ranCommand));
    const { items } = coordinator.snapshot;
    assert.deepEqual(
      items.map(({ kind }) => kind),
      ['user', 'tool', 'assistant'],
    );
    assert.equal(items[0]!.text, '!git status');
    assert.equal(items[1]!.title, 'git status');
    assert.equal(items[1]!.shell, true);
  } finally {
    await coordinator.close();
  }
  const reopened = await reopen();
  try {
    const row = reopened.snapshot.items.find(({ kind }) => kind === 'tool');
    assert.equal(row?.shell, true);
  } finally {
    await reopened.close();
  }
});

test('a ! prompt sent during a turn waits in the queue and runs alone before the prompts after it', async () => {
  const { coordinator, a } = await fixture();
  const gate = new TurnGate();
  try {
    a.gate = gate;
    const first = coordinator.send('first');
    await within(gate.entered, 2000, 'the gated turn');
    await coordinator.send('!ls');
    await coordinator.send('after');
    assert.deepEqual(coordinator.snapshot.queue, ['!ls', 'after']);
    assert.deepEqual(a.steers, []);
    gate.open();
    await within(first, 5000, 'the queue');
    const prompts = a.inputs.map(({ prompt }) => prompt);
    assert.equal(prompts.length, 3);
    assert.ok(prompts[0]! === 'first');
    assert.ok(prompts[1]! === '!ls');
    assert.ok(prompts[2]! === 'after');
    assert.deepEqual(a.shells, ['ls']);
  } finally {
    gate.open();
    await coordinator.close();
  }
});

test('a ! command that fails posts its error and sends no turn', async () => {
  const { coordinator, a } = await fixture();
  try {
    a.failNext = true;
    await coordinator.send('!x');
    assert.equal(coordinator.snapshot.phase, 'idle');
    assert.deepEqual(a.inputs, []);
    const last = coordinator.snapshot.items.at(-1);
    assert.equal(last?.kind, 'notice');
    assert.equal(last?.text, 'Overloaded');
  } finally {
    await coordinator.close();
  }
});

test('an interrupt that lands as a ! command finishes sends no turn', async () => {
  const { coordinator, a } = await fixture();
  const gate = new TurnGate();
  try {
    a.gate = gate;
    a.finishShellOnInterrupt = true;
    const sending = coordinator.send('!x');
    await within(gate.entered, 2000, 'the gated command');
    await coordinator.interrupt();
    await within(sending, 3000, 'the turn');
    assert.equal(coordinator.snapshot.phase, 'idle');
    assert.deepEqual(a.inputs, []);
    const last = coordinator.snapshot.items.at(-1);
    assert.equal(last?.kind, 'notice');
    assert.equal(last?.text, 'Turn interrupted');
  } finally {
    gate.open();
    await coordinator.close();
  }
});

test('after the reply, while a familiar holds the turn, a ! prompt runs at once and steers its reply, shown after the prompt', async () => {
  const { coordinator, a } = await fixture();
  const gate = new TurnGate();
  try {
    a.gate = gate;
    const sending = coordinator.send('Start');
    await within(gate.entered, 2000, 'the gated turn');
    a.replied = true;
    await coordinator.send('!git status');
    assert.deepEqual(a.shells, ['git status']);
    assert.deepEqual(a.steers, [
      '!git status\n\nThe user ran this command themselves, and its output is above. Reply to it without running it again.',
    ]);
    assert.deepEqual(coordinator.snapshot.queue, []);
    const [prompt, row] = coordinator.snapshot.items.slice(-2);
    assert.equal(prompt?.kind, 'user');
    assert.equal(prompt?.text, '!git status');
    assert.equal(row?.kind, 'tool');
    assert.equal(row?.title, 'git status');
    assert.equal(row?.shell, true);
    gate.open();
    await within(sending, 2000, 'the turn');
    assert.deepEqual(turns(a), [['Start', undefined]]);
  } finally {
    gate.open();
    await coordinator.close();
  }
});

test('after the reply, a listed spell steers trimmed with its call, and an unlisted slash command steers as a prompt', async () => {
  const { coordinator, a } = await fixture(undefined, (a) => {
    a.skills = [{ name: 'review', description: 'Review changes' }];
  });
  const gate = new TurnGate();
  try {
    a.gate = gate;
    const sending = coordinator.send('Start');
    await within(gate.entered, 2000, 'the gated turn');
    a.replied = true;
    await coordinator.send(' /review now');
    await coordinator.send('/unlisted-command');
    assert.deepEqual(a.steers, ['/review now', '/unlisted-command']);
    assert.deepEqual(a.skillSteers, [{ name: 'review', args: 'now' }]);
    assert.deepEqual(coordinator.snapshot.queue, []);
    gate.open();
    await within(sending, 2000, 'the turn');
    assert.deepEqual(turns(a), [['Start', undefined]]);
  } finally {
    gate.open();
    await coordinator.close();
  }
});

test("a model change runs during a replied turn without waiting, and is refused during one that hasn't replied", async () => {
  const { coordinator, a, b } = await fixture();
  const gate = new TurnGate();
  try {
    a.gate = gate;
    const sending = coordinator.send('Start');
    await within(gate.entered, 2000, 'the gated turn');
    await assert.rejects(
      coordinator.selectModel({ agent: 'a', id: 'a-big', effort: 'high' }),
      {
        message: 'Stop the current operation first',
      },
    );
    a.replied = true;
    await coordinator.selectModel({ agent: 'a', id: 'a-big', effort: 'high' });
    assert.equal(coordinator.snapshot.phase, 'running');
    assert.deepEqual(a.selections.at(-1), ['a-big', 'high']);
    assert.equal(coordinator.snapshot.conversation!.sessions.a!.model, 'a-big');
    const discoveries = b.discoveries.length;
    const sourceInputs = a.inputs.length;
    await assert.rejects(
      coordinator.selectModel({ agent: 'b', id: 'b-big' }),
      /Wait for the running familiars or workflows/,
    );
    assert.equal(a.inputs.length, sourceInputs);
    assert.equal(a.sessions.at(-1)!.session.closed, false);
    assert.equal(b.sessions.length, 0);
    assert.equal(b.discoveries.length, discoveries);
    gate.open();
    await within(sending, 2000, 'the turn');
  } finally {
    gate.open();
    await coordinator.close();
  }
});

test('a model change during a replied turn refuses another until it finishes, and the refusal reports as a notice', async () => {
  const { coordinator, a } = await fixture();
  const gate = new TurnGate();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let first: Promise<void> | undefined;
  let duplicate: Promise<void> | undefined;
  try {
    const { session } = a.sessions.at(-1)!;
    const select = session.selectModel.bind(session);
    session.selectModel = async (...args) => {
      entered.resolve();
      await release.promise;
      await select(...args);
    };
    a.gate = gate;
    const sending = coordinator.send('Start');
    await within(gate.entered, 2000, 'the gated turn');
    a.replied = true;
    const before = a.selections.length;
    first = coordinator.selectModel({
      agent: 'a',
      id: 'a-big',
      effort: 'high',
    });
    await within(entered.promise, 2000, 'the model change');
    duplicate = coordinator.selectModel({ agent: 'a', id: 'a-model' });
    const refusal = await within(
      duplicate.catch((error: unknown) => error),
      2000,
      'the overlapping model change refusal',
    );
    assert.ok(refusal instanceof Error);
    assert.equal(refusal.message, 'Stop the current operation first');
    coordinator.report(refusal);
    assert.equal(coordinator.snapshot.error, undefined);
    const notice = coordinator.snapshot.items.at(-1);
    assert.deepEqual(
      [notice?.kind, notice?.text],
      ['notice', 'Stop the current operation first'],
    );
    release.resolve();
    await first;
    assert.deepEqual(a.selections.slice(before), [['a-big', 'high']]);
    assert.equal(coordinator.snapshot.conversation!.sessions.a!.model, 'a-big');
    await coordinator.selectModel({ agent: 'a', id: 'a-model' });
    assert.equal(
      coordinator.snapshot.conversation!.sessions.a!.model,
      'a-model',
    );
    gate.open();
    await within(sending, 2000, 'the turn');
  } finally {
    release.resolve();
    await Promise.allSettled([first, duplicate]);
    gate.open();
    await coordinator.close();
  }
});

for (const rejected of [false, true])
  test(
    rejected
      ? 'a rejected replied model change leaves queued prompts unsent'
      : 'a replied model change finishes before the next queued turn starts',
    async () => {
      const { coordinator, a, root } = await fixture();
      const gate = new TurnGate();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const atNextSend: { model: string; effort?: string }[] = [];
      const order: string[] = [];
      let selecting: Promise<void> | undefined;
      let sending: Promise<void> | undefined;
      try {
        const { session } = a.sessions.at(-1)!;
        const select = session.selectModel.bind(session);
        session.selectModel = async (...args) => {
          entered.resolve();
          await release.promise;
          if (rejected) throw new Error('Model rejected');
          await select(...args);
          order.push('selection completed');
        };
        const send = session.send.bind(session);
        session.send = async (prompt, skill, context) => {
          if (prompt === '/queued') {
            atNextSend.push({
              model: session.info.model,
              effort: session.info.effort,
            });
            order.push('queued send');
          }
          return send(prompt, skill, context);
        };
        a.gate = gate;
        sending = coordinator.send('Start');
        await within(gate.entered, 2000, 'the first turn');
        a.replied = true;
        const change = coordinator.selectModel({
          agent: 'a',
          id: 'a-big',
          effort: 'high',
        });
        selecting = rejected
          ? assert.rejects(change, { message: 'Model rejected' })
          : change;
        await within(entered.promise, 2000, 'the model change');
        a.refuseSteer = true;
        await coordinator.send('/queued');
        gate.open();
        await within(gate.result, 2000, 'the native turn');
        // the native result precedes coordinator persistence and its next queue read
        await delay(400);
        assert.deepEqual(atNextSend, []);
        assert.deepEqual(coordinator.snapshot.queue, ['/queued']);
        release.resolve();
        await within(
          Promise.all([selecting, sending]),
          3000,
          'the settled model change',
        );
        if (rejected) {
          assert.equal(coordinator.snapshot.error, 'Model rejected');
          assert.deepEqual(coordinator.snapshot.queue, ['/queued']);
          assert.equal(a.inputs.length, 1);
          assert.equal(
            coordinator.snapshot.conversation!.sessions.a!.model,
            'a-model',
          );
        } else {
          assert.deepEqual(atNextSend, [{ model: 'a-big', effort: 'high' }]);
          assert.deepEqual(order, ['selection completed', 'queued send']);
          const saved = await readRecord(
            root,
            coordinator.snapshot.conversation!.id,
          );
          assert.equal(saved.sessions.a!.model, 'a-big');
          assert.equal(saved.sessions.a!.effort, 'high');
          assert.deepEqual(coordinator.snapshot.queue, []);
          assert.deepEqual(turns(a), [
            ['Start', undefined],
            ['/queued', undefined],
          ]);
        }
      } finally {
        release.resolve();
        gate.open();
        await selecting;
        await coordinator.close();
        await sending;
      }
    },
  );

test('a replied turn opens the model list from its connect without refreshing', async () => {
  const { coordinator, a } = await fixture();
  const gate = new TurnGate();
  try {
    a.gate = gate;
    const sending = coordinator.send('Start');
    await within(gate.entered, 2000, 'the gated turn');
    a.replied = true;
    const { models } = coordinator.snapshot;
    a.failModels = true;
    assert.equal(await coordinator.refreshModels(), true);
    assert.equal(coordinator.snapshot.models, models);
    assert.equal(a.failModels, true);
    gate.open();
    await within(sending, 2000, 'the turn');
  } finally {
    gate.open();
    await coordinator.close();
  }
});

test('commands that need idle say familiars or workflows hold the turn, and the usual refusal otherwise', async () => {
  const { coordinator, a } = await fixture();
  const gate = new TurnGate();
  try {
    a.gate = gate;
    const sending = coordinator.send('Start');
    await within(gate.entered, 2000, 'the gated turn');
    await assert.rejects(coordinator.newConversation(), {
      message: 'Stop the current operation first',
    });
    a.replied = true;
    await assert.rejects(coordinator.newConversation(), {
      message:
        'Wait for the running familiars or workflows to report, or press Escape to stop them',
    });
    gate.open();
    await within(sending, 2000, 'the turn');
  } finally {
    gate.open();
    await coordinator.close();
  }
});
