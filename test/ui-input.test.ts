import assert from 'node:assert/strict';
import { createElement } from 'react';
import { render } from 'ink-testing-library';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Input } from '../src/ui/input.js';
import { Request } from '../src/ui/request.js';
import { render as renderTerminal, Box } from 'ink';
import { PassThrough, Writable } from 'node:stream';

await test('the terminal composer keeps a bracketed paste unsent until Enter', async () => {
  const sent: string[] = [];
  const ui = render(
    createElement(Input, {
      width: 60,
      height: 4,
      cwd: '/work',
      active: true,
      onSubmit: (value) => {
        sent.push(value);
        return true;
      },
    }),
  );
  try {
    await delay(20);
    ui.stdin.write('\u001b[200~first\nsecond\u001b[201~');
    await delay(20);
    assert.deepEqual(sent, []);
    assert.match(ui.lastFrame() ?? '', /first/);
    assert.match(ui.lastFrame() ?? '', /second/);
    ui.stdin.write('\r');
    await delay(20);
    assert.deepEqual(sent, ['first\nsecond']);
  } finally {
    ui.unmount();
  }
});

await test('the visible terminal cursor reaches the current insertion point without an extra keystroke', async () => {
  class InputStream extends PassThrough {
    isTTY = true;
    setRawMode() {
      return this;
    }
    ref() {
      return this;
    }
    unref() {
      return this;
    }
  }
  class OutputStream extends Writable {
    isTTY = true;
    columns = 80;
    rows = 24;
    output = '';
    _write(
      chunk: Buffer,
      _: BufferEncoding,
      callback: (error?: Error | null) => void,
    ) {
      this.output += chunk.toString();
      callback();
    }
  }
  const stdin = new InputStream();
  const stdout = new OutputStream();
  const ui = renderTerminal(
    createElement(
      Box,
      { paddingLeft: 2 },
      createElement(Input, {
        width: 30,
        height: 3,
        cwd: '/work',
        active: true,
        onSubmit: () => true,
      }),
    ),
    { stdin, stdout, stderr: stdout, interactive: true, patchConsole: false },
  );
  try {
    await delay(30);
    stdin.write('abc');
    await delay(40);
    await ui.waitUntilRenderFlush();
    assert.equal([...stdout.output.matchAll(/\[(\d+)G/g)].at(-1)?.[1], '6');
    ui.rerender(
      createElement(Input, {
        width: 10,
        height: 3,
        cwd: '/work',
        active: true,
        onSubmit: () => true,
      }),
    );
    await delay(30);
    stdin.write('a abcdefghi');
    await delay(30);
    for (let index = 0; index < 6; index++) {
      stdin.write('\u001b[D');
      await delay(15);
    }
    await ui.waitUntilRenderFlush();
    assert.equal([...stdout.output.matchAll(/\[(\d+)G/g)].at(-1)?.[1], '4');
    assert.ok(stdout.output.includes('\u001b[2A\u001b[4G'));
  } finally {
    ui.unmount();
  }
});

await test('native secret questions mask the display and preserve commas in a single answer', async () => {
  const answers: unknown[] = [];
  const ui = render(
    createElement(Request, {
      width: 60,
      height: 20,
      cwd: '/work',
      request: {
        id: 'secret',
        kind: 'question',
        title: 'Question',
        detail: '',
        questions: [
          { id: 'answer', title: 'Secret value', options: [], secret: true },
        ],
      },
      respond: (value) => answers.push(value),
    }),
  );
  try {
    await delay(30);
    ui.stdin.write('\u001b[200~red, green\u001b[201~');
    await delay(30);
    assert.ok(!ui.frames.some((frame) => frame.includes('red, green')));
    assert.ok(ui.lastFrame()?.includes('•••'));
    ui.stdin.write('\r');
    await delay(30);
    assert.deepEqual(answers, [
      { decision: 'accept', answers: { answer: ['red, green'] } },
    ]);
  } finally {
    ui.unmount();
  }
});
