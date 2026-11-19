import assert from 'node:assert/strict';
import { test } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createElement } from 'react';
import { App } from '../../src/ui/App.js';
import { TurnGate } from '../fixtures/agent.js';
import { fixture, turns } from '../fixtures/coordinator.js';
import { png } from '../fixtures/png.js';
import {
  show,
  fake,
  prompts,
  ENTER,
  SHIFT_ENTER,
  DOWN,
  UP,
  tools,
} from '../fixtures/ui.js';
import { until, within } from '../fixtures/within.js';

/** a small PNG written into `directory`, with the bracketed paste a terminal sends for its path. */
async function image(directory: string) {
  const bytes = png(16, 16);
  const path = join(directory, 'shot.png');
  await writeFile(path, bytes);

  return { bytes, paste: `\u001b[200~${path}\u001b[201~` };
}

/** the bytes of the images a turn was sent with. */
const delivered = (images: readonly string[] = []) =>
  Promise.all(images.map((path) => readFile(path)));

test('Enter during a turn sends the draft and empties the composer', async () => {
  const { app, calls } = fake({ phase: 'running' });
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));

  try {
    await delay(60);
    ui.stdin.write('hello');
    await delay(30);
    ui.stdin.write(ENTER);
    await until('the send', () => calls.length > 0);
    assert.deepEqual(calls, [['send', 'hello', { composer: true }]]);

    await until('the empty composer', () =>
      ui.text().includes('┃ Ask the agent'),
    );
  } finally {
    ui.unmount();
  }
});

test('queued prompts show above the command window with a hint, and ↑ on the first line takes them back ahead of the draft, where ↑ on a later line moves the cursor', async () => {
  const { app, calls } = fake({
    phase: 'running',
    queue: ['one', 'two\nlines'],
  });

  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));

  try {
    await until('the queue', () => ui.text().includes('❯ two lines'));
    const lines = ui.text().split('\n');
    const window = lines.findIndex((line) => line.trim() === 'TOOLS');

    assert.deepEqual(
      lines.slice(window - 2, window).map((line) => line.trim()),
      ['❯ one', '❯ two lines'],
    );

    assert.ok(ui.text().includes('┃ Press ↑ to edit queued messages'));
    ui.stdin.write('first');
    ui.stdin.write(SHIFT_ENTER);
    ui.stdin.write('second');
    await until('the draft', () => ui.text().includes('┃ second'));
    ui.stdin.write(UP);
    await delay(60);
    assert.deepEqual(calls, []);
    ui.stdin.write(UP);
    await until('the queue taken back', () => !ui.text().includes('❯ one'));
    assert.deepEqual(calls, [['unqueue', 'one\ntwo\nlines\nfirst\nsecond']]);

    const rows = ['┃ one', '┃ two', '┃ lines', '┃ first', '┃ second'].map(
      (row) => ui.text().indexOf(row),
    );

    assert.ok(
      rows.every((row, index) => row >= 0 && row > (rows[index - 1] ?? -1)),
      ui.text(),
    );
  } finally {
    ui.unmount();
  }
});

test('a queued prompt with an image marker, taken back with ↑ and sent again, is delivered with its image', async () => {
  const { coordinator, a, project } = await fixture();
  const gate = new TurnGate();
  a.gate = gate;
  a.refuseSteer = true;
  const { bytes, paste } = await image(project);
  const ui = show(createElement(App, { coordinator, onExit: () => {} }));
  const sending = coordinator.send('held turn');

  try {
    await within(gate.entered, 3000, 'the gated turn');
    ui.stdin.write('look');
    await until('the draft', () => ui.text().includes('┃ look'));
    ui.stdin.write(paste);
    await until('the marker', () => ui.text().includes('┃ look [Image #1]'));
    ui.stdin.write(ENTER);

    await until('the queued prompt', () =>
      ui.text().includes('❯ look [Image #1]'),
    );

    ui.stdin.write(UP);

    await until(
      'the prompt taken back',
      () =>
        !ui.text().includes('❯ look') &&
        ui.text().includes('┃ look [Image #1]'),
    );

    assert.deepEqual(coordinator.snapshot.queue, []);
    ui.stdin.write(ENTER);

    await until('the prompt queued again', () =>
      ui.text().includes('❯ look [Image #1]'),
    );

    gate.open();
    await within(sending, 5000, 'the queued turn');
    await until('the image prompt', () => a.inputs.length === 2);

    assert.deepEqual(turns(a), [
      ['held turn', undefined],
      ['look [Image #1]', undefined],
    ]);

    assert.deepEqual(await delivered(a.inputs[1]!.images), [bytes]);
    assert.deepEqual(a.steers, []);
  } finally {
    gate.open();
    await sending;
    ui.unmount();
    await coordinator.close();
  }
});

for (const [command, message] of [
  ['/task unexpected', 'Use /task, /task release or /task take <reference>.'],
  ['/new', 'Stop the current operation first'],
  ['/clear', 'Stop the current operation first'],
] as const)
  test(`${command} leaves queued prompts runnable`, async () => {
    const { coordinator, a } = await fixture();
    const gate = new TurnGate();
    a.gate = gate;
    a.refuseSteer = true;
    const ui = show(createElement(App, { coordinator, onExit: () => {} }));
    const sending = coordinator.send('held turn');

    try {
      await within(gate.entered, 3000, 'the gated turn');
      await coordinator.send('queued followup');

      await until('the queued followup', () =>
        ui.text().includes('❯ queued followup'),
      );

      ui.stdin.write(command);

      await until('the command in the composer', () =>
        ui.text().includes(`┃ ${command}`),
      );

      ui.stdin.write(ENTER);
      await until('the notice', () => ui.text().includes(message));
      gate.open();
      await within(sending, 5000, 'the queued turns');

      assert.deepEqual(turns(a), [
        ['held turn', undefined],
        ['queued followup', undefined],
      ]);

      assert.deepEqual(coordinator.snapshot.queue, []);
      assert.equal(coordinator.snapshot.error, undefined);
      assert.deepEqual(a.steers, []);
      assert.deepEqual(a.compactions, []);

      await until('the empty composer', () =>
        ui.text().includes('┃ Ask the agent'),
      );

      assert.ok(ui.text().includes(message), ui.text());
    } finally {
      gate.open();
      await sending;
      ui.unmount();
      await coordinator.close();
    }
  });

test('/model during a turn shows its pending choice and delivers queued input after the handoff', async () => {
  const { coordinator, a, b } = await fixture();
  const gate = new TurnGate();
  a.gate = gate;
  a.refuseSteer = true;
  const ui = show(createElement(App, { coordinator, onExit: () => {} }));
  const sending = coordinator.send('held turn');

  try {
    await within(gate.entered, 3000, 'the gated turn');
    ui.stdin.write('/model b:b-big');

    await until('the model command', () =>
      ui.text().includes('┃ /model b:b-big'),
    );

    ui.stdin.write(ENTER);

    await until('the pending model', () =>
      ui.text().includes('Pending: /model b:b-big'),
    );

    assert.equal(coordinator.snapshot.phase, 'running');
    assert.equal(b.sessions.length, 0);
    ui.stdin.write('queued followup');

    await until('the followup draft', () =>
      ui.text().includes('┃ queued followup'),
    );

    ui.stdin.write(ENTER);

    await until('the queued followup', () =>
      coordinator.snapshot.queue.includes('queued followup'),
    );

    gate.open();

    await until('the destination turn', () =>
      b.inputs.some(({ prompt }) => prompt === 'queued followup'),
    );

    await until(
      'the completed batch',
      () =>
        coordinator.snapshot.phase === 'idle' &&
        !coordinator.snapshot.commandsPending,
    );

    assert.equal(coordinator.snapshot.conversation!.agent, 'b');
    assert.equal(b.sessions.at(-1)!.session.info.model, 'b-big');
    assert.deepEqual(turns(b), [['queued followup', undefined]]);
    assert.equal(coordinator.snapshot.pendingModel, undefined);
    assert.deepEqual(coordinator.snapshot.queue, []);
    assert.equal(coordinator.snapshot.error, undefined);
  } finally {
    gate.open();
    await sending;
    ui.unmount();
    await coordinator.close();
  }
});

test('a /sessions choice refused during a turn leaves queued prompts runnable', async () => {
  const { coordinator, a } = await fixture();
  const ui = show(createElement(App, { coordinator, onExit: () => {} }));
  await coordinator.send('first prompt');
  await coordinator.newConversation();
  const { id } = coordinator.snapshot.conversation!;
  const gate = new TurnGate();
  a.gate = gate;
  a.refuseSteer = true;
  const sending = coordinator.send('held turn');

  try {
    await within(gate.entered, 3000, 'the gated turn');
    await coordinator.send('queued followup');

    await until('the queued followup', () =>
      ui.text().includes('❯ queued followup'),
    );

    ui.stdin.write('/sessions');

    await until('the command in the composer', () =>
      ui.text().includes('┃ /sessions'),
    );

    ui.stdin.write(ENTER);

    await until('the first conversation', () =>
      ui.text().includes('a · first prompt'),
    );

    ui.stdin.write('first prompt');
    ui.stdin.write(ENTER);

    await until('the notice', () =>
      ui.text().includes('Stop the current operation first'),
    );

    assert.equal(coordinator.snapshot.error, undefined);
    gate.open();
    await within(sending, 5000, 'the queued turns');
    assert.equal(coordinator.snapshot.conversation!.id, id);

    assert.deepEqual(turns(a), [
      ['first prompt', undefined],
      ['held turn', undefined],
      ['queued followup', undefined],
    ]);
  } finally {
    gate.open();
    await sending;
    ui.unmount();
    await coordinator.close();
  }
});

test('accepting failed-turn memory returns queued prompts ahead of the draft', async () => {
  const { coordinator, a } = await fixture();
  const gate = new TurnGate();
  const ui = show(createElement(App, { coordinator, onExit: () => {} }));

  try {
    await until('the composer', () => ui.text().includes('┃ Ask the agent'));
    a.gate = gate;
    a.failNext = true;
    a.refuseSteer = true;
    const sending = coordinator.send('remember-port');
    await within(gate.entered, 3000, 'the gated turn');
    await coordinator.send('/audit');
    await coordinator.send('queued followup');
    ui.stdin.write('unsent draft');
    await until('the draft', () => ui.text().includes('┃ unsent draft'));
    gate.open();
    await sending;

    await until('the recovery page', () =>
      ui.text().includes('Unfinished memory changes'),
    );

    await delay(550);
    ui.stdin.write('a');
    const rows = ['┃ /audit', '┃ queued followup', '┃ unsent draft'];

    await until('the restored draft', () =>
      rows.every((row) => ui.text().includes(row)),
    );

    const offsets = rows.map((row) => ui.text().indexOf(row));

    assert.ok(
      offsets.every((offset, index) => offset > (offsets[index - 1] ?? -1)),
      ui.text(),
    );

    assert.equal(coordinator.snapshot.phase, 'idle');
    assert.deepEqual(coordinator.snapshot.queue, []);
    assert.deepEqual(turns(a), [['remember-port', undefined]]);
    ui.stdin.write(ENTER);

    await until(
      'the explicit submission completes',
      () => a.inputs.length > 1 && coordinator.snapshot.phase === 'idle',
    );

    assert.deepEqual(turns(a), [
      ['remember-port', undefined],
      ['/audit\nqueued followup\nunsent draft', undefined],
    ]);
  } finally {
    gate.open();
    ui.unmount();
    await coordinator.close();
  }
});

test('a queue longer than the free rows shows its first prompts and keeps the composer in view', async () => {
  const { app } = fake({
    phase: 'running',
    queue: Array.from({ length: 60 }, (_, index) => `prompt ${index}`),
  });

  const ui = show(
    createElement(App, { coordinator: app, onExit: () => {} }),
    100,
    24,
  );

  try {
    await until('the queue', () => ui.text().includes('❯ prompt 0'));
    assert.ok(ui.text().includes('┃ Press ↑ to edit queued messages'));
    assert.ok(!ui.text().includes('❯ prompt 59'));
  } finally {
    ui.unmount();
  }
});

test('↑ in an open completion list leaves the queue', async () => {
  const { app, calls } = fake({ phase: 'running', queue: ['one'] });
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));

  try {
    await until('the queue', () => ui.text().includes('❯ one'));
    ui.stdin.write('/');
    await delay(60);
    ui.stdin.write(UP);
    await delay(60);
    assert.deepEqual(calls, []);
    assert.ok(ui.text().includes('❯ one'));
  } finally {
    ui.unmount();
  }
});

test('Tab and ↑ in one read focus tools and leave the queue', async () => {
  const { app, calls } = fake({
    phase: 'running',
    items: tools('first'),
    queue: ['one'],
  });

  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));

  try {
    await until('the queue', () => ui.text().includes('❯ one'));
    ui.stdin.write(`\t${UP}`);
    await until('the focused tools', () => ui.text().includes('TAB COMPOSE'));
    await delay(60);
    assert.deepEqual(calls, []);
    assert.ok(ui.text().includes('❯ one'));
  } finally {
    ui.unmount();
  }
});

test('↑ with nothing queued and no earlier prompts leaves the draft as typed', async () => {
  const { app, calls } = fake({});
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));

  try {
    await delay(60);
    ui.stdin.write('abc');
    await delay(30);
    ui.stdin.write(UP);
    await delay(60);
    assert.deepEqual(calls, []);
    assert.ok(ui.text().includes('┃ abc'));
  } finally {
    ui.unmount();
  }
});

test('↑ on the first line shows older prompts from this directory with the cursor at the end, and ↓ on the last line newer ones with the cursor at the start, back to the draft', async () => {
  const { app } = fake({});
  const { store } = prompts(['newer\nlines', 'older']);

  const ui = show(
    createElement(App, { coordinator: app, store, onExit: () => {} }),
  );

  try {
    await delay(60);
    ui.stdin.write('draft');
    await until('the draft', () => ui.text().includes('┃ draft'));
    ui.stdin.write(UP);
    await until('the newer prompt', () => ui.text().includes('┃ newer'));
    ui.stdin.write(UP);
    await delay(60);
    assert.ok(!ui.text().includes('┃ older'), ui.text());
    ui.stdin.write(UP);
    await until('the older prompt', () => ui.text().includes('┃ older'));
    ui.stdin.write(DOWN);
    await until('the newer prompt again', () => ui.text().includes('┃ newer'));
    ui.stdin.write(DOWN);
    await delay(60);
    assert.ok(!ui.text().includes('┃ draft'), ui.text());
    ui.stdin.write(DOWN);
    await until('the draft again', () => ui.text().includes('┃ draft'));
  } finally {
    ui.unmount();
  }
});

test('an edit to a recalled prompt survives browsing and is sent and recorded, the recalled prompt stays as it was, and browsing then starts at the newest', async () => {
  const { app, calls } = fake({});
  const { store, added } = prompts(['first', 'second']);

  const ui = show(
    createElement(App, { coordinator: app, store, onExit: () => {} }),
  );

  try {
    await delay(60);
    ui.stdin.write(UP);
    await until('the first prompt', () => ui.text().includes('┃ first'));
    ui.stdin.write(' edited');
    await until('the edit', () => ui.text().includes('┃ first edited'));
    ui.stdin.write(UP);
    await until('the second prompt', () => ui.text().includes('┃ second'));
    ui.stdin.write(DOWN);
    await until('the edit kept', () => ui.text().includes('┃ first edited'));
    ui.stdin.write(ENTER);
    await until('the send', () => calls.length > 0);
    assert.deepEqual(calls, [['send', 'first edited', { composer: true }]]);
    assert.deepEqual(added, [['/work', 'first edited']]);
    ui.stdin.write(UP);
    await until('the sent prompt', () => ui.text().includes('┃ first edited'));
    ui.stdin.write(UP);

    await until('the first prompt as it was', () =>
      /┃ first +┃/.test(ui.text()),
    );
  } finally {
    ui.unmount();
  }
});

test('a prompt with an image marker recalled with ↑ delivers its image again', async () => {
  const { coordinator, a, store, project } = await fixture();
  const { bytes, paste } = await image(project);
  const ui = show(createElement(App, { coordinator, store, onExit: () => {} }));

  try {
    await until('the composer', () => ui.text().includes('┃ Ask the agent'));
    ui.stdin.write('look');
    await until('the draft', () => ui.text().includes('┃ look'));
    ui.stdin.write(paste);
    await until('the marker', () => ui.text().includes('┃ look [Image #1]'));
    ui.stdin.write(ENTER);

    await until(
      'the first turn',
      () => a.inputs.length === 1 && coordinator.snapshot.phase === 'idle',
    );

    ui.stdin.write(UP);

    await until('the recalled prompt', () =>
      ui.text().includes('┃ look [Image #1]'),
    );

    ui.stdin.write(ENTER);
    await until('the second turn', () => a.inputs.length === 2);

    assert.deepEqual(turns(a), [
      ['look [Image #1]', undefined],
      ['look [Image #1]', undefined],
    ]);

    assert.deepEqual(await delivered(a.inputs[0]!.images), [bytes]);
    assert.deepEqual(await delivered(a.inputs[1]!.images), [bytes]);
  } finally {
    ui.unmount();
    await coordinator.close();
  }
});

test('a prompt and a Witch command are recorded once each, and neither a blank send nor a repeat of the newest is', async () => {
  const { app, calls } = fake({});
  const { store, added } = prompts([]);

  const ui = show(
    createElement(App, { coordinator: app, store, onExit: () => {} }),
  );

  try {
    await delay(60);
    ui.stdin.write(ENTER);
    await delay(30);
    ui.stdin.write('hello');
    await delay(30);
    ui.stdin.write(ENTER);
    await until('the send', () => calls.some(([, text]) => text === 'hello'));
    ui.stdin.write(UP);
    await until('the recalled prompt', () => ui.text().includes('┃ hello'));
    ui.stdin.write(ENTER);

    await until(
      'the second send',
      () => calls.filter(([, text]) => text === 'hello').length === 2,
    );

    ui.stdin.write('/model gpt');
    await delay(30);
    ui.stdin.write(ENTER);

    await until('the model', () =>
      calls.some(([name]) => name === 'selectModel'),
    );

    assert.deepEqual(added, [
      ['/work', 'hello'],
      ['/work', '/model gpt'],
    ]);
  } finally {
    ui.unmount();
  }
});

test('↑ takes queued prompts back before it shows earlier ones, and ↓ returns to them', async () => {
  const { app, calls } = fake({ phase: 'running', queue: ['queued'] });
  const { store } = prompts(['earlier']);

  const ui = show(
    createElement(App, { coordinator: app, store, onExit: () => {} }),
  );

  try {
    await until('the queue', () => ui.text().includes('❯ queued'));
    ui.stdin.write(UP);
    await until('the queue taken back', () => ui.text().includes('┃ queued'));
    assert.deepEqual(calls, [['unqueue', 'queued']]);
    ui.stdin.write(UP);
    await until('the earlier prompt', () => ui.text().includes('┃ earlier'));
    ui.stdin.write(DOWN);
    await until('the queue again', () => ui.text().includes('┃ queued'));
  } finally {
    ui.unmount();
  }
});

test('prompts that come back mid-browse end browsing and go ahead of the draft typed before it', async () => {
  const { app, coordinator } = fake({});
  const { store } = prompts(['one']);

  const ui = show(
    createElement(App, { coordinator: app, store, onExit: () => {} }),
  );

  try {
    await delay(60);
    ui.stdin.write('draft');
    await until('the draft', () => ui.text().includes('┃ draft'));
    ui.stdin.write(UP);
    await until('the recalled prompt', () => ui.text().includes('┃ one'));
    coordinator.publish({ queue: ['late'] });
    await until('the returned prompt', () => ui.text().includes('┃ late'));

    const [late, draft] = ['┃ late', '┃ draft'].map((row) =>
      ui.text().indexOf(row),
    );

    assert.ok(late! >= 0 && draft! > late!, ui.text());
    assert.ok(!ui.text().includes('┃ one'), ui.text());
    ui.stdin.write(DOWN);
    ui.stdin.write(DOWN);
    await delay(60);
    assert.ok(ui.text().includes('┃ late'), ui.text());
  } finally {
    ui.unmount();
  }
});

test('an initial prompt sent mid-browse leaves the browsed prompt in place without a list, and comes back between it and the draft', async () => {
  const { app, coordinator, calls } = fake({ phase: 'starting' });
  const { store } = prompts(['/mo', 'older']);

  const ui = show(
    createElement(App, {
      coordinator: app,
      store,
      onExit: () => {},
      initialPrompt: 'say hello',
    }),
  );

  try {
    await delay(60);
    ui.stdin.write(UP);
    await until('the recalled command', () => ui.text().includes('┃ /mo'));
    coordinator.publish({ phase: 'idle' });

    await until('the initial prompt sent', () =>
      calls.some(([name]) => name === 'send'),
    );

    await delay(60);
    assert.ok(ui.text().includes('┃ /mo'), ui.text());
    assert.ok(!ui.text().includes('Choose model and reasoning'), ui.text());
    ui.stdin.write(UP);
    await until('the older prompt', () => ui.text().includes('┃ older'));
    ui.stdin.write(DOWN);
    await until('the command again', () => ui.text().includes('┃ /mo'));
    ui.stdin.write(DOWN);
    await until('the initial prompt', () => ui.text().includes('┃ say hello'));
    ui.stdin.write(DOWN);
    await until('the draft', () => ui.text().includes('┃ Ask the agent'));
  } finally {
    ui.unmount();
  }
});

test('an initial prompt sent after browsing back to the draft is the first prompt ↑ shows', async () => {
  const { app, coordinator, calls } = fake({ phase: 'starting' });
  const { store } = prompts(['newest', 'older']);

  const ui = show(
    createElement(App, {
      coordinator: app,
      store,
      onExit: () => {},
      initialPrompt: 'say hello',
    }),
  );

  try {
    await delay(60);
    ui.stdin.write(UP);
    await until('the newest prompt', () => ui.text().includes('┃ newest'));
    ui.stdin.write(DOWN);
    await until('the draft', () => ui.text().includes('┃ Ask the agent'));
    coordinator.publish({ phase: 'idle' });

    await until('the initial prompt sent', () =>
      calls.some(([name]) => name === 'send'),
    );

    ui.stdin.write(UP);
    await until('the initial prompt', () => ui.text().includes('┃ say hello'));
    ui.stdin.write(UP);

    await until('the newest prompt again', () =>
      ui.text().includes('┃ newest'),
    );

    ui.stdin.write(UP);
    await until('the older prompt', () => ui.text().includes('┃ older'));
  } finally {
    ui.unmount();
  }
});

test('a recalled prompt opens no completion list until it is edited, even with the cursor in its file token, so ↑ goes on to older prompts', async () => {
  const { app } = fake({}, ['src/a.ts']);
  const { store } = prompts(['@src/a.ts\nnext', '/mo', 'older']);

  const ui = show(
    createElement(App, { coordinator: app, store, onExit: () => {} }),
  );

  try {
    await delay(60);
    ui.stdin.write(UP);
    await until('the prompt naming a file', () => ui.text().includes('┃ next'));
    ui.stdin.write(UP);
    await delay(60);
    assert.doesNotMatch(ui.text(), /^ *@src\/a\.ts *$/m);
    ui.stdin.write(UP);
    await until('the command', () => ui.text().includes('┃ /mo'));
    assert.ok(!ui.text().includes('Choose model and reasoning'), ui.text());
    ui.stdin.write(UP);
    await until('the older prompt', () => ui.text().includes('┃ older'));
    ui.stdin.write(DOWN);
    await until('the command again', () => ui.text().includes('┃ /mo'));
    ui.stdin.write('\u001b[F');
    ui.stdin.write('d');

    await until('the list once edited', () =>
      ui.text().includes('Choose model and reasoning'),
    );
  } finally {
    ui.unmount();
  }
});

test('a conversation switch starts browsing again at the newest prompt as recorded, and the conversation left gets back the draft typed before browsing', async () => {
  const { app, coordinator } = fake({});
  const { store } = prompts(['one', 'two']);
  const conversation = coordinator.snapshot.conversation!;

  const ui = show(
    createElement(App, { coordinator: app, store, onExit: () => {} }),
  );

  try {
    await delay(60);
    ui.stdin.write('draft');
    await until('the draft', () => ui.text().includes('┃ draft'));
    ui.stdin.write(UP);
    await until('the newest prompt', () => ui.text().includes('┃ one'));
    ui.stdin.write(' edited');
    await until('the edit', () => ui.text().includes('┃ one edited'));
    ui.stdin.write(UP);
    await until('the older prompt', () => ui.text().includes('┃ two'));
    coordinator.publish({ conversation: { ...conversation, id: 'c2' } });

    await until('the next conversation', () =>
      ui.text().includes('┃ Ask the agent'),
    );

    ui.stdin.write(DOWN);
    await delay(60);
    assert.ok(ui.text().includes('┃ Ask the agent'), ui.text());
    ui.stdin.write(UP);

    await until('the newest prompt as recorded', () =>
      /┃ one +┃/.test(ui.text()),
    );

    coordinator.publish({ conversation });
    await until('the draft back', () => ui.text().includes('┃ draft'));
  } finally {
    ui.unmount();
  }
});

test('a draft holding an image marker, left for another conversation and back, delivers the image when sent', async () => {
  const { coordinator, a, project } = await fixture();
  const { bytes, paste } = await image(project);
  const ui = show(createElement(App, { coordinator, onExit: () => {} }));

  try {
    const original = coordinator.snapshot.conversation!.id;
    await until('the composer', () => ui.text().includes('┃ Ask the agent'));
    ui.stdin.write('look');
    await until('the draft', () => ui.text().includes('┃ look'));
    ui.stdin.write(paste);
    await until('the marker', () => ui.text().includes('┃ look [Image #1]'));
    await coordinator.newConversation();

    await until('the next conversation', () =>
      ui.text().includes('┃ Ask the agent'),
    );

    await coordinator.selectConversation(original);

    await until('the draft back', () =>
      ui.text().includes('┃ look [Image #1]'),
    );

    ui.stdin.write(ENTER);
    await until('the image prompt', () => a.inputs.length === 1);
    assert.deepEqual(turns(a), [['look [Image #1]', undefined]]);
    assert.deepEqual(await delivered(a.inputs[0]!.images), [bytes]);
  } finally {
    ui.unmount();
    await coordinator.close();
  }
});
