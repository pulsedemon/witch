import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createElement } from 'react';
import { App } from '../src/ui/app.js';
import {
  show,
  fake,
  prompts,
  ENTER,
  SHIFT_ENTER,
  DOWN,
  UP,
  tools,
} from './fixtures/ui.js';
import { until } from './fixtures/within.js';

await test('Enter during a turn sends the draft and empties the composer', async () => {
  const { app, calls } = fake({ phase: 'running' });
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
  try {
    await delay(60);
    ui.stdin.write('hello');
    await delay(30);
    ui.stdin.write(ENTER);
    await until('the send', () => calls.length > 0);
    assert.deepEqual(calls, [['send', 'hello']]);
    await until('the empty composer', () =>
      ui.text().includes('┃ Ask the agent'),
    );
  } finally {
    ui.unmount();
  }
});

await test('queued prompts show above the activity row with a hint, and ↑ on the first line takes them back ahead of the draft, where ↑ on a later line moves the cursor', async () => {
  const { app, calls } = fake({
    phase: 'running',
    queue: ['one', 'two\nlines'],
  });
  const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
  try {
    await until('the queue', () => ui.text().includes('❯ two lines'));
    const lines = ui.text().split('\n');
    const activity = lines.findIndex((line) =>
      line.includes('ESC TO INTERRUPT'),
    );
    assert.deepEqual(
      lines.slice(activity - 2, activity).map((line) => line.trim()),
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
    assert.deepEqual(calls, [['unqueue']]);
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

await test('a queue longer than the free rows shows its first prompts and keeps the composer in view', async () => {
  const { app } = fake({
    phase: 'running',
    queue: Array.from({ length: 60 }, (_, index) => `prompt ${index}`),
  });
  const ui = show(
    createElement(App, { coordinator: app, onExit: () => {} }),
    100,
    20,
  );
  try {
    await until('the queue', () => ui.text().includes('❯ prompt 0'));
    assert.ok(ui.text().includes('┃ Press ↑ to edit queued messages'));
    assert.ok(!ui.text().includes('❯ prompt 59'));
  } finally {
    ui.unmount();
  }
});

await test('↑ in an open list moves its selection and leaves the queue', async () => {
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

await test('Tab and ↑ in one read move through tools and leave the queue', async () => {
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

await test('↑ with nothing queued and no earlier prompts leaves the draft as typed', async () => {
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

await test('↑ on the first line shows older prompts from this directory with the cursor at the end, and ↓ on the last line newer ones with the cursor at the start, back to the draft', async () => {
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

await test('an edit to a recalled prompt survives browsing and is sent and recorded, the recalled prompt stays as it was, and browsing then starts at the newest', async () => {
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
    assert.deepEqual(calls, [['send', 'first edited']]);
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

await test('a prompt and a Witch command are recorded once each, and neither a blank send nor a repeat of the newest is', async () => {
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

await test('↑ takes queued prompts back before it shows earlier ones, and ↓ returns to them', async () => {
  const { app, calls } = fake({ phase: 'running', queue: ['queued'] });
  const { store } = prompts(['earlier']);
  const ui = show(
    createElement(App, { coordinator: app, store, onExit: () => {} }),
  );
  try {
    await until('the queue', () => ui.text().includes('❯ queued'));
    ui.stdin.write(UP);
    await until('the queue taken back', () => ui.text().includes('┃ queued'));
    assert.deepEqual(calls, [['unqueue']]);
    ui.stdin.write(UP);
    await until('the earlier prompt', () => ui.text().includes('┃ earlier'));
    ui.stdin.write(DOWN);
    await until('the queue again', () => ui.text().includes('┃ queued'));
  } finally {
    ui.unmount();
  }
});

await test('prompts that come back mid-browse end browsing and go ahead of the draft typed before it', async () => {
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

await test('an initial prompt sent mid-browse leaves the browsed prompt in place without a list, and comes back between it and the draft', async () => {
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

await test('an initial prompt sent after browsing back to the draft is the first prompt ↑ shows', async () => {
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

await test('a recalled prompt opens no completion list until it is edited, even with the cursor in its file token, so ↑ goes on to older prompts', async () => {
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

await test('a conversation switch starts browsing again at the newest prompt as recorded, and the conversation left gets back the draft typed before browsing', async () => {
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
