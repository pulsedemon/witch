import assert from 'node:assert/strict';
import { act, createElement, type ReactElement } from 'react';
import { render } from 'ink-testing-library';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Input } from '../src/ui/input.js';
import { Request } from '../src/ui/request.js';
import { render as renderTerminal, Box } from 'ink';
import { PassThrough, Writable } from 'node:stream';
import type { UserResponse } from '../src/agents/types.js';

// act returns once React has committed and run effects, so a key never races a handler still attaching
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

async function mount(element: ReactElement) {
  let ui!: ReturnType<typeof render>;
  await act(async () => {
    ui = render(element);
  });
  return ui;
}

/** writes keys inside act. the yield lets a stream stdin emit them before act returns */
const press = (stdin: { write: (data: string) => unknown }, data: string) =>
  act(async () => {
    stdin.write(data);
    await delay(0);
  });

/** Ink holds a lone Escape for 20 ms in case a sequence follows. a later, longer timer fires after it */
const escape = (stdin: { write: (data: string) => unknown }) =>
  act(async () => {
    stdin.write('\u001b');
    await delay(30);
  });

const unmount = (ui: { unmount: () => void }) =>
  act(async () => {
    ui.unmount();
  });

/** passes the 500 ms in which a new request ignores keys */
const ready = () => act(() => delay(600));

await test('the terminal composer keeps a bracketed paste unsent until Enter', async () => {
  const sent: string[] = [];
  const ui = await mount(
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
    await press(ui.stdin, '\u001b[200~first\nsecond\u001b[201~');
    assert.deepEqual(sent, []);
    assert.match(ui.lastFrame() ?? '', /first/);
    assert.match(ui.lastFrame() ?? '', /second/);
    await press(ui.stdin, '\r');
    assert.deepEqual(sent, ['first\nsecond']);
  } finally {
    await unmount(ui);
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
  let ui!: ReturnType<typeof renderTerminal>;
  await act(async () => {
    ui = renderTerminal(
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
  });
  const rerender = (element: ReactElement) =>
    act(async () => {
      ui.rerender(element);
    });
  const column = async () => {
    await ui.waitUntilRenderFlush();
    return [...stdout.output.matchAll(/\[(\d+)G/g)].at(-1)?.[1];
  };
  try {
    await press(stdin, 'abc');
    assert.equal(await column(), '6');
    await rerender(
      createElement(Input, {
        width: 10,
        height: 3,
        active: true,
        onSubmit: () => true,
      }),
    );
    await press(stdin, 'a abcdefghi');
    await press(stdin, '\u001b[D'.repeat(6));
    assert.equal(await column(), '4');
    assert.ok(stdout.output.includes('\u001b[2A\u001b[4G'));
    for (const [text, width, end, left] of [
      ['a\tb', 30, '10', '9'],
      ['éab', 30, '4', '3'],
      ['éabcd', 5, '1', '5'],
    ] as const) {
      const submitted: string[] = [];
      await rerender(
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
      await press(stdin, `\u001b[200~${text}\u001b[201~`);
      assert.equal(await column(), end);
      await press(stdin, '\u001b[D');
      assert.equal(await column(), left);
      await press(stdin, '\r');
      assert.deepEqual(submitted, [text]);
    }
    await rerender(
      createElement(Input, {
        key: 'lines',
        width: 30,
        height: 3,
        active: true,
        onSubmit: () => true,
      }),
    );
    // Up from the end of `cd` lands before the newline that ends `ab`
    await press(stdin, '\u001b[200~ab\ncd\u001b[201~\u001b[A');
    await ui.waitUntilRenderFlush();
    const moves = [
      // eslint-disable-next-line no-control-regex
      ...stdout.output.matchAll(/\[(\d+)A\u001b\[(\d+)G/g),
    ];
    assert.deepEqual(moves.at(-1)?.slice(1), ['3', '3']);
  } finally {
    await unmount(ui);
  }
});

await test('native secret questions mask the display and preserve commas in a single answer, and a multiple answer splits', async () => {
  const answers: unknown[] = [];
  const ui = await mount(
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
          {
            id: 'colors',
            title: 'Colors?',
            options: ['red', 'green', 'blue'],
            multiple: true,
          },
        ],
      },
      respond: (value) => answers.push(value),
    }),
  );
  try {
    await ready();
    await press(ui.stdin, '\u001b[200~red, green\u001b[201~');
    assert.ok(!ui.frames.some((frame) => frame.includes('red, green')));
    assert.ok(ui.lastFrame()?.includes('•••'));
    await press(ui.stdin, '\r');
    await press(ui.stdin, '1, 3');
    await press(ui.stdin, '\r');
    assert.deepEqual(answers, [
      {
        decision: 'accept',
        answers: { answer: ['red, green'], colors: ['red', 'blue'] },
      },
    ]);
  } finally {
    await unmount(ui);
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
    const ui = await mount(
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
      await ready();
      if (text) await press(ui.stdin, `\u001b[200~${text}\u001b[201~`);
      await press(ui.stdin, '\r');
      assert.deepEqual(sent, []);
      assert.match(ui.lastFrame() ?? '', error);
      if (!text) {
        await press(ui.stdin, `\u001b[200~${JSON.stringify(valid)}\u001b[201~`);
        await press(ui.stdin, '\r');
        assert.deepEqual(sent, [{ decision: 'accept', content: valid }]);
      } else {
        await escape(ui.stdin);
        assert.deepEqual(sent, [{ decision: 'decline' }]);
      }
    } finally {
      await unmount(ui);
    }
  }
});

await test('an MCP form whose schema names draft-07 validates the answer', async () => {
  const sent: UserResponse[] = [];
  const ui = await mount(
    createElement(Request, {
      width: 100,
      height: 25,
      cwd: '/work',
      request: {
        id: 'form',
        kind: 'elicitation',
        title: 'Contact',
        detail: 'MCP server',
        schema: {
          $schema: 'http://json-schema.org/draft-07/schema#',
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
        },
      },
      respond: (response) => sent.push(response),
    }),
  );
  try {
    await ready();
    await press(ui.stdin, '\r');
    assert.deepEqual(sent, []);
    assert.match(ui.lastFrame() ?? '', /required property 'name'/);
    await press(
      ui.stdin,
      `\u001b[200~${JSON.stringify({ name: 'Ada' })}\u001b[201~`,
    );
    await press(ui.stdin, '\r');
    assert.deepEqual(sent, [{ decision: 'accept', content: { name: 'Ada' } }]);
  } finally {
    await unmount(ui);
  }
});

await test('a validation error quoting a schema property name cannot carry a link of its own', async () => {
  const ui = await mount(
    createElement(Request, {
      width: 100,
      height: 25,
      cwd: '/work',
      request: {
        id: 'form',
        kind: 'elicitation',
        title: 'Contact',
        detail: 'MCP server',
        schema: {
          type: 'object',
          required: [
            '\u001b]8;;https://evil.example/share\u0007name\u001b]8;;\u0007' +
              '\u001b\u001b[31m]8;;https://evil.example/share\u0007name\u001b\u001b[0m]8;;\u0007',
          ],
        },
      },
      respond: () => {},
    }),
  );
  try {
    await ready();
    await press(ui.stdin, '\r');
    // the body shows the schema as JSON, where the URL is visible text and links as such
    const error = (ui.lastFrame() ?? '')
      .split('\n')
      .find((line) => line.includes('required property'));
    assert.match(error ?? '', /required property 'name/);
    assert.ok(!error?.includes('\u001b]8;;'), JSON.stringify(error));
  } finally {
    await unmount(ui);
  }
});

await test('browser elicitation confirms without JSON form content', async () => {
  const sent: UserResponse[] = [];
  const ui = await mount(
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
    await ready();
    await press(ui.stdin, '\r');
    assert.deepEqual(sent, [{ decision: 'accept', content: undefined }]);
  } finally {
    await unmount(ui);
  }
});
