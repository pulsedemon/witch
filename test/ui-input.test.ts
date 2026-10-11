import assert from 'node:assert/strict';
import { createElement } from 'react';
import { render } from 'ink-testing-library';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Input } from '../src/ui/input.js';
import { Request } from '../src/ui/request.js';
import { render as renderTerminal, Box } from 'ink';
import { PassThrough, Writable } from 'node:stream';
import type { UserResponse } from '../src/agents/types.js';

await test('the terminal composer keeps a bracketed paste unsent until Enter', async () => {
  const sent: string[] = [];
  const ui = render(
    createElement(Input, {
      width: 60,
      height: 4,
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
        active: true,
        onSubmit: () => true,
      }),
    );
    await delay(30);
    stdin.write('a abcdefghi');
    await delay(30);
    stdin.write('\u001b[D'.repeat(6));
    await delay(30);
    await ui.waitUntilRenderFlush();
    assert.equal([...stdout.output.matchAll(/\[(\d+)G/g)].at(-1)?.[1], '4');
    assert.ok(stdout.output.includes('\u001b[2A\u001b[4G'));
    for (const [text, width, column, leftColumn] of [
      ['a\tb', 30, '10', '9'],
      ['e\u0301ab', 30, '4', '3'],
      ['e\u0301abcd', 5, '1', '5'],
    ] as const) {
      const submitted: string[] = [];
      ui.rerender(
        createElement(Input, {
          key: text,
          width,
          height: 3,
          active: true,
          onSubmit: (value) => {
            submitted.push(value);
            return true;
          },
        }),
      );
      await delay(30);
      stdin.write(`\u001b[200~${text}\u001b[201~`);
      await delay(30);
      await ui.waitUntilRenderFlush();
      assert.equal(
        [...stdout.output.matchAll(/\[(\d+)G/g)].at(-1)?.[1],
        column,
      );
      stdin.write('\u001b[D');
      await delay(30);
      await ui.waitUntilRenderFlush();
      assert.equal(
        [...stdout.output.matchAll(/\[(\d+)G/g)].at(-1)?.[1],
        leftColumn,
      );
      stdin.write('\r');
      await delay(30);
      assert.deepEqual(submitted, [text]);
    }
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
    // past the 500 ms in which a new request ignores keys
    await delay(600);
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

await test('MCP form submissions validate required fields, types and constraints before responding', async () => {
  const schema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      email: {
        type: 'string',
        format: 'email',
        default: 'default@example.com',
      },
      age: { type: 'integer', minimum: 18, maximum: 120 },
      colors: {
        type: 'array',
        minItems: 1,
        maxItems: 2,
        items: { enum: ['red', 'blue'] },
      },
    },
    required: ['email', 'age', 'colors'],
  };
  const valid = { email: 'user@example.com', age: 21, colors: ['blue'] };
  const cases = [
    ['', /required property 'email'/],
    [
      JSON.stringify({ age: 21, colors: ['blue'] }),
      /required property 'email'/,
    ],
    [JSON.stringify({ ...valid, age: '21' }), /must be integer/],
    [JSON.stringify({ ...valid, age: 17 }), /must be >= 18/],
    [JSON.stringify({ ...valid, email: 'invalid' }), /must match format/],
    [
      JSON.stringify({ ...valid, colors: [] }),
      /must NOT have fewer than 1 items/,
    ],
    [
      JSON.stringify({ ...valid, colors: ['green'] }),
      /must be equal to one of/,
    ],
  ] as const;
  for (const [text, error] of cases) {
    const sent: UserResponse[] = [];
    const ui = render(
      createElement(Request, {
        width: 100,
        height: 25,
        cwd: '/work',
        request: {
          id: 'form',
          kind: 'elicitation',
          title: 'Contact',
          detail: 'MCP server',
          schema,
        },
        respond: (response) => sent.push(response),
      }),
    );
    try {
      await delay(600);
      if (text) ui.stdin.write(`\u001b[200~${text}\u001b[201~`);
      await delay(30);
      ui.stdin.write('\r');
      await delay(40);
      assert.deepEqual(sent, []);
      assert.match(ui.lastFrame() ?? '', error);
      if (!text) {
        ui.stdin.write(`\u001b[200~${JSON.stringify(valid)}\u001b[201~`);
        await delay(30);
        ui.stdin.write('\r');
        await delay(40);
        assert.deepEqual(sent, [{ decision: 'accept', content: valid }]);
      } else {
        ui.stdin.write('\u001b');
        await delay(30);
        assert.deepEqual(sent, [{ decision: 'decline' }]);
      }
    } finally {
      ui.unmount();
    }
  }
});

await test('browser elicitation confirms without JSON form content', async () => {
  const sent: UserResponse[] = [];
  const ui = render(
    createElement(Request, {
      width: 80,
      height: 20,
      cwd: '/work',
      request: {
        id: 'url',
        kind: 'elicitation',
        title: 'Connect',
        detail: 'MCP server',
        url: 'https://example.com/connect',
      },
      respond: (response) => sent.push(response),
    }),
  );
  try {
    await delay(600);
    ui.stdin.write('\r');
    await delay(30);
    assert.deepEqual(sent, [{ decision: 'accept', content: undefined }]);
  } finally {
    ui.unmount();
  }
});
