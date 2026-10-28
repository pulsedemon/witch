import assert from 'node:assert/strict';
import { test } from 'vitest';
import { TurnGate } from './fixtures/agent.js';
import { fixture, turns } from './fixtures/coordinator.js';
import { until, within } from './fixtures/within.js';

const review = { name: 'review', description: 'Review changes' };

for (const [source, expectedError] of [
  ['model list', 'a: model/list failed'],
  ['spell discovery', 'Skills unavailable'],
  ['inactive discovery', 'b: Discovery failed'],
] as const)
  test(`a ${source} failure during reconnect leaves queued prompts runnable`, async () => {
    const { coordinator, a } = await fixture(undefined, (_a, b) => {
      b.failDiscovery = source === 'inactive discovery';
    });
    const gate = new TurnGate();
    try {
      await a.sessions.at(-1)!.session.close();
      a.failModels = source === 'model list';
      a.failSkills = source === 'spell discovery';
      a.refuseSteer = true;
      a.gate = gate;
      const before = coordinator.snapshot.items.length;
      const sending = coordinator.send('first after reconnect');
      await within(gate.entered, 3000, 'the reconnected turn');
      await coordinator.send('distinct queued followup');
      gate.open();
      await within(sending, 3000, 'the queued followup');
      assert.deepEqual(
        a.inputs.map(({ prompt }) => prompt),
        ['first after reconnect', 'distinct queued followup'],
      );
      assert.deepEqual(coordinator.snapshot.queue, []);
      assert.equal(coordinator.snapshot.error, undefined);
      assert.equal(coordinator.snapshot.phase, 'idle');
      assert.deepEqual(
        coordinator.snapshot.items
          .slice(before)
          .filter(({ kind }) => kind === 'notice')
          .map(({ text }) => text),
        [expectedError],
      );
    } finally {
      gate.open();
      await coordinator.close();
    }
  });

for (const [name, prompt] of [
  [
    'a screenshot path',
    '/var/folders/xx/Screenshot 2026-10-26 at 2.52.19 PM.png clicking on the "product-decisions.md" link produced this error',
  ],
  [
    'a path after spaces, with a later line',
    '  /var/folders/xx/a.png\nwhat is this',
  ],
  ["a path under a listed spell's name", '/review/notes.md is stale'],
  ['an unlisted command', '/clear'],
] as const)
  test(`a prompt that starts with ${name} steers into the running turn`, async () => {
    const { coordinator, a } = await fixture(undefined, (a) => {
      a.skills = [review];
    });
    const gate = new TurnGate();
    try {
      a.gate = gate;
      const sending = coordinator.send('Start');
      await within(gate.entered, 2000, 'the gated turn');
      await coordinator.send(prompt);
      assert.deepEqual(a.steers, [prompt]);
      assert.deepEqual(a.skillSteers, []);
      assert.deepEqual(coordinator.snapshot.queue, []);
      const row = coordinator.snapshot.items.at(-1)!;
      assert.deepEqual([row.kind, row.text], ['user', prompt]);
      gate.open();
      await within(sending, 2000, 'the turn');
      assert.deepEqual(turns(a), [['Start', undefined]]);
    } finally {
      gate.open();
      await coordinator.close();
    }
  });

test('a prompt sent behind a spell the turn refused steers past it, and the spell goes alone next', async () => {
  const { coordinator, a } = await fixture(undefined, (a) => {
    a.skills = [review];
  });
  const gate = new TurnGate();
  try {
    a.gate = gate;
    a.refuseSkillSteer = true;
    const sending = coordinator.send('Start');
    await within(gate.entered, 2000, 'the gated turn');
    await coordinator.send('/review now');
    assert.deepEqual(coordinator.snapshot.queue, ['/review now']);
    assert.ok(
      !coordinator.snapshot.items.some(({ text }) => text === '/review now'),
    );
    await coordinator.send('after');
    assert.deepEqual(a.steers, ['after']);
    assert.deepEqual(coordinator.snapshot.queue, ['/review now']);
    gate.open();
    await within(sending, 2000, 'the queued turn');
    assert.deepEqual(turns(a), [
      ['Start', undefined],
      ['/review now', { name: 'review', args: 'now' }],
    ]);
  } finally {
    gate.open();
    await coordinator.close();
  }
});

test('a spell an interrupt leaves unread goes alone next with its skill call', async () => {
  const { coordinator, a } = await fixture(undefined, (a) => {
    a.skills = [review];
  });
  const gate = new TurnGate();
  try {
    a.gate = gate;
    a.unreadOnInterrupt = true;
    const sending = coordinator.send('Start');
    await within(gate.entered, 2000, 'the gated turn');
    await coordinator.send('/review now');
    assert.deepEqual(a.skillSteers, [{ name: 'review', args: 'now' }]);
    await coordinator.interrupt();
    gate.open();
    await within(sending, 2000, 'the next turn');
    assert.equal((await gate.result).status, 'interrupted');
    assert.deepEqual(turns(a), [
      ['Start', undefined],
      ['/review now', { name: 'review', args: 'now' }],
    ]);
    assert.deepEqual(coordinator.snapshot.queue, []);
  } finally {
    gate.open();
    await coordinator.close();
  }
});

test('prompts queued behind a queued prompt steer into the turn it starts, and a ! command and what follows wait', async () => {
  const { coordinator, a } = await fixture(undefined, (a) => {
    a.skills = [review];
  });
  const first = new TurnGate();
  const second = new TurnGate();
  try {
    a.gate = first;
    a.refuseSteer = true;
    const sending = coordinator.send('Start');
    await within(first.entered, 2000, 'the gated turn');
    for (const prompt of ['/review now', 'B', '!ls', 'C'])
      await coordinator.send(prompt);
    a.gate = second;
    a.refuseSteer = false;
    // a replied turn would take a `!` command, so only the queue's rule holds it back
    a.replied = true;
    first.open();
    await within(second.entered, 2000, "the spell's turn");
    await until('the steer behind it', () => a.steers.length > 0);
    assert.deepEqual(a.steers, ['B']);
    assert.deepEqual(coordinator.snapshot.queue, ['!ls', 'C']);
    second.open();
    await within(sending, 5000, 'the queued turns');
    assert.deepEqual(turns(a), [
      ['Start', undefined],
      ['/review now', { name: 'review', args: 'now' }],
      ['!ls', undefined],
      ['C', undefined],
    ]);
    assert.deepEqual(a.shells, ['ls']);
  } finally {
    first.open();
    second.open();
    await coordinator.close();
  }
});

test('a spell refused behind a queued turn stays queued while the prompts after it steer', async () => {
  const { coordinator, a } = await fixture(undefined, (a) => {
    a.skills = [review];
  });
  const first = new TurnGate();
  const second = new TurnGate();
  try {
    a.gate = first;
    a.refuseSteer = true;
    const sending = coordinator.send('Start');
    await within(first.entered, 2000, 'the gated turn');
    for (const prompt of ['A', '/review now', 'B'])
      await coordinator.send(prompt);
    a.refuseSteer = false;
    a.refuseSkillSteer = true;
    a.gate = second;
    first.open();
    await within(second.entered, 2000, "A's turn");
    await until('the steer behind it', () => a.steers.length > 0);
    assert.deepEqual(a.steers, ['B']);
    assert.deepEqual(coordinator.snapshot.queue, ['/review now']);
    second.open();
    await within(sending, 2000, 'the queued turns');
    assert.deepEqual(turns(a), [
      ['Start', undefined],
      ['A', undefined],
      ['/review now', { name: 'review', args: 'now' }],
    ]);
  } finally {
    first.open();
    second.open();
    await coordinator.close();
  }
});

test('an ordinary prompt refused behind a queued turn keeps the prompts after it behind it', async () => {
  const { coordinator, a } = await fixture(undefined, (a) => {
    a.skills = [review];
  });
  const first = new TurnGate();
  const second = new TurnGate();
  try {
    a.gate = first;
    a.refuseSteer = true;
    const sending = coordinator.send('Start');
    await within(first.entered, 2000, 'the gated turn');
    for (const prompt of ['/review now', 'B', 'C'])
      await coordinator.send(prompt);
    const { session } = a.sessions.at(-1)!;
    const steer = session.steer.bind(session);
    const asked: string[] = [];
    session.steer = async (prompt, options) => {
      asked.push(prompt);
      return prompt !== 'B' && steer(prompt, options);
    };
    a.gate = second;
    a.refuseSteer = false;
    first.open();
    await within(second.entered, 2000, "the spell's turn");
    await until('the refused steer', () => asked.length > 0);
    assert.deepEqual(a.steers, []);
    assert.deepEqual(coordinator.snapshot.queue, ['B', 'C']);
    second.open();
    await within(sending, 2000, 'the queued turns');
    assert.deepEqual(turns(a), [
      ['Start', undefined],
      ['/review now', { name: 'review', args: 'now' }],
      ['B\nC', undefined],
    ]);
  } finally {
    first.open();
    second.open();
    await coordinator.close();
  }
});

test('a prompt sent behind a prompt the turn refused waits behind it', async () => {
  const { coordinator, a } = await fixture();
  const gate = new TurnGate();
  try {
    a.gate = gate;
    const sending = coordinator.send('Start');
    await within(gate.entered, 2000, 'the gated turn');
    a.refuseSteer = true;
    await coordinator.send('A');
    a.refuseSteer = false;
    await coordinator.send('B');
    assert.deepEqual(a.steers, []);
    assert.deepEqual(coordinator.snapshot.queue, ['A', 'B']);
    gate.open();
    await within(sending, 2000, 'the queued turn');
    assert.deepEqual(turns(a), [
      ['Start', undefined],
      ['A\nB', undefined],
    ]);
  } finally {
    gate.open();
    await coordinator.close();
  }
});

test('a queued prompt that starts with a path joins the prompts after it in one turn', async () => {
  const { coordinator, a } = await fixture();
  const gate = new TurnGate();
  try {
    a.gate = gate;
    a.refuseSteer = true;
    const sending = coordinator.send('Start');
    await within(gate.entered, 2000, 'the gated turn');
    await coordinator.send('/var/folders/xx/a.png what is this');
    await coordinator.send('B');
    gate.open();
    await within(sending, 2000, 'the queued turn');
    assert.deepEqual(turns(a), [
      ['Start', undefined],
      ['/var/folders/xx/a.png what is this\nB', undefined],
    ]);
  } finally {
    gate.open();
    await coordinator.close();
  }
});

test('a turn whose input was never written puts its steered prompts back between the batch and the rest', async () => {
  const { coordinator, a } = await fixture();
  const gate = new TurnGate();
  try {
    const { session } = a.sessions.at(-1)!;
    const send = session.send.bind(session);
    session.send = async (...args) => {
      await send(...args);
      return {
        status: 'failed',
        text: '',
        error: 'Input delivery failed',
        inputUnsent: true,
        unread: ['follow'],
      };
    };
    a.gate = gate;
    const sending = coordinator.send('Start');
    await within(gate.entered, 2000, 'the gated turn');
    await coordinator.send('follow');
    assert.deepEqual(a.steers, ['follow']);
    a.refuseSteer = true;
    await coordinator.send('later');
    gate.open();
    await within(sending, 2000, 'the failed turn');
    assert.deepEqual(coordinator.snapshot.queue, ['Start', 'follow', 'later']);
  } finally {
    gate.open();
    await coordinator.close();
  }
});
