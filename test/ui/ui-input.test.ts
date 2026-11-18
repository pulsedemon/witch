import assert from 'node:assert/strict';
import { act, createElement, createRef, type ReactElement } from 'react';
import { render } from 'ink-testing-library';
import { test } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { Input, type InputHandle } from '../../src/ui/input/Input.js';
import { Request } from '../../src/ui/Request.js';
import { render as renderTerminal, Box } from 'ink';
import { PassThrough, Writable } from 'node:stream';
import type { UserRequest, UserResponse } from '../../src/agents/types.js';

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

/** the yield lets a stream stdin emit keys before act returns. */
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

const mountRequest = (
  request: UserRequest,
  respond: (response: UserResponse) => void,
  width = 100,
  height = 25,
) =>
  mount(
    createElement(Request, { width, height, cwd: '/work', request, respond }),
  );

for (const width of [1, 2]) {
  test(`shell input remains visible and editable at width ${width}`, async () => {
    const sent: string[] = [];

    const ui = await mount(
      createElement(Input, {
        width,
        height: 1,
        active: true,
        shell: true,
        initialValue: '!echo',
        onSubmit(value) {
          sent.push(value);

          return true;
        },
      }),
    );

    try {
      await press(ui.stdin, '\u001b[D');
      assert.match(ui.lastFrame() ?? '', /o/);
      await press(ui.stdin, 'X\u001b[D');
      assert.match(ui.lastFrame() ?? '', /X/);
      await press(ui.stdin, '\u001b[3~');
      assert.match(ui.lastFrame() ?? '', /o/);
      assert.doesNotMatch(ui.lastFrame() ?? '', /X/);
      await press(ui.stdin, 'Y\u001b[D');
      assert.match(ui.lastFrame() ?? '', /Y/);
      await press(ui.stdin, '\r');
      assert.deepEqual(sent, ['!echYo']);
    } finally {
      await unmount(ui);
    }
  });
}

test('the terminal composer keeps a bracketed paste unsent until Enter', async () => {
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

test('pasted controls are removed without hiding or dropping following text', async () => {
  const changes: [string, number][] = [];
  const sent: string[] = [];

  const ui = await mount(
    createElement(Input, {
      width: 60,
      height: 4,
      active: true,
      onChange: (value, cursor) => changes.push([value, cursor]),
      onSubmit: (value) => {
        sent.push(value);

        return true;
      },
    }),
  );

  try {
    await press(ui.stdin, '\u001b[200~ab\u009bcde\u001b[201~');
    assert.equal(ui.lastFrame()?.split('\n')[0], 'abcde');
    assert.deepEqual(changes.at(-1), ['abcde', 5]);
    assert.deepEqual(sent, []);
    await press(ui.stdin, '\u001b[13u');
    assert.deepEqual(sent, ['abcde']);
  } finally {
    await unmount(ui);
  }
});

test('filtered pastes preserve Unicode and line breaks at the current cursor', async () => {
  const changes: [string, number][] = [];
  const sent: string[] = [];

  const ui = await mount(
    createElement(Input, {
      width: 60,
      height: 6,
      active: true,
      initialValue: 'LR',
      onChange: (value, cursor) => changes.push([value, cursor]),
      onSubmit: (value) => {
        sent.push(value);

        return true;
      },
    }),
  );

  try {
    const pasted = 'a\u0000b\u009bc\u0007d\t中\r\nr\rs\n👩‍💻';
    const expected = 'Labcd\t中\nr\ns\n👩‍💻R';
    await press(ui.stdin, '\u001b[D');
    await press(ui.stdin, `\u001b[200~${pasted}\u001b[201~`);
    assert.deepEqual(changes.at(-1), [expected, expected.length - 1]);

    assert.deepEqual(ui.lastFrame()?.split('\n').slice(0, 4), [
      'Labcd   中',
      'r',
      's',
      '👩‍💻R',
    ]);

    await press(ui.stdin, 'X');

    assert.deepEqual(changes.at(-1), [
      'Labcd\t中\nr\ns\n👩‍💻XR',
      expected.length,
    ]);

    await press(ui.stdin, '\u001b[13u');
    assert.deepEqual(sent, ['Labcd\t中\nr\ns\n👩‍💻XR']);
  } finally {
    await unmount(ui);
  }
});

test('a paste goes to onPaste with the text before the cursor, and its replacement, or the paste when it gives none, goes in at the cursor', async () => {
  const changes: [string, number][] = [];
  const pastes: [string, string][] = [];

  const ui = await mount(
    createElement(Input, {
      width: 60,
      height: 4,
      active: true,
      initialValue: 'look here',
      onChange: (value, cursor) => changes.push([value, cursor]),
      onSubmit: () => true,
      onPaste: (text, before) => {
        pastes.push([text, before]);

        return text === '/tmp/shot.png' ? ' [Image #1]' : undefined;
      },
    }),
  );

  try {
    for (let i = 0; i < 5; i++) await press(ui.stdin, '\u001b[D');

    await press(ui.stdin, '\u001b[200~/tmp/shot.png\u001b[201~');
    assert.deepEqual(changes.at(-1), ['look [Image #1] here', 15]);
    await press(ui.stdin, '\u001b[200~more\u001b[201~');
    assert.deepEqual(changes.at(-1), ['look [Image #1]more here', 19]);

    assert.deepEqual(pastes, [
      ['/tmp/shot.png', 'look'],
      ['more', 'look [Image #1]'],
    ]);
  } finally {
    await unmount(ui);
  }
});

test('typed text never goes to onPaste', async () => {
  const changes: [string, number][] = [];
  const pastes: string[] = [];

  const ui = await mount(
    createElement(Input, {
      width: 60,
      height: 4,
      active: true,
      onChange: (value, cursor) => changes.push([value, cursor]),
      onSubmit: () => true,
      onPaste: (text) => {
        pastes.push(text);

        return ' [Image #1]';
      },
    }),
  );

  try {
    await press(ui.stdin, '/tmp/shot.png');
    assert.deepEqual(changes.at(-1), ['/tmp/shot.png', 13]);
    assert.deepEqual(pastes, []);
  } finally {
    await unmount(ui);
  }
});

test('a paste after a shell ! goes in as written without onPaste, even when a recalled command leaves the cursor before the !', async () => {
  const changes: [string, number][] = [];
  const pastes: string[] = [];
  const input = createRef<InputHandle>();

  const ui = await mount(
    createElement(Input, {
      ref: input,
      width: 60,
      height: 4,
      active: true,
      shell: true,
      initialValue: '!open ',
      onChange: (value, cursor) => changes.push([value, cursor]),
      onSubmit: () => true,
      onPaste: (text) => {
        pastes.push(text);

        return ' [Image #1]';
      },
    }),
  );

  try {
    await press(ui.stdin, '\u001b[200~/tmp/a.png\u001b[201~');
    assert.deepEqual(changes.at(-1), ['!open /tmp/a.png', 16]);
    await act(async () => input.current!.set({ value: '!ls', cursor: 0 }));
    await press(ui.stdin, '\u001b[200~/tmp/b.png\u001b[201~');
    assert.deepEqual(changes.at(-1), ['!/tmp/b.pngls', 11]);
    assert.deepEqual(pastes, []);
  } finally {
    await unmount(ui);
  }
});

test('the visible terminal cursor reaches the current insertion point without an extra keystroke', async () => {
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

test('native secret questions mask the display and preserve commas in a single answer, and a multiple answer splits', async () => {
  const answers: unknown[] = [];

  const ui = await mountRequest(
    {
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
    (value) => answers.push(value),
    60,
    20,
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

test("a question's answer fills the request's width", async () => {
  const ui = await mountRequest(
    {
      id: 'name',
      kind: 'question',
      title: 'Question',
      detail: '',
      questions: [{ id: 'name', title: 'Name?', options: [] }],
    },
    () => {},
    40,
    20,
  );

  try {
    await ready();
    await press(ui.stdin, 'q'.repeat(41));
    assert.match(ui.lastFrame() ?? '', /(?<!q)q{40}(?!q)/);
  } finally {
    await unmount(ui);
  }
});

test('MCP form submissions validate required fields, types and constraints before responding', async () => {
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
    ['{', /Enter a JSON object matching the requested fields/],
    ['[]', /Enter a JSON object matching the requested fields/],
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

    const ui = await mountRequest(
      {
        id: 'form',
        kind: 'elicitation',
        title: 'Contact',
        detail: 'MCP server',
        schema,
      },
      (response) => sent.push(response),
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

for (const [width, height] of [
  [98, 37],
  [18, 7],
] as const)
  test(`a long validation error stays actionable and editable at ${width} by ${height}`, async () => {
    const property =
      'customerBillingAddressInternationalShippingDetailsContactInformationPrimaryTelephoneNumber';

    const sent: UserResponse[] = [];

    const ui = await mountRequest(
      {
        id: 'form',
        kind: 'elicitation',
        title: 'Contact',
        detail: '',
        schema: {
          type: 'object',
          properties: { [property]: { type: 'string' } },
        },
      },
      (response) => sent.push(response),
      width,
      height,
    );

    try {
      await ready();
      const invalid = JSON.stringify({ [property]: 123 });
      await press(ui.stdin, `\u001b[200~${invalid}\u001b[201~`);
      await press(ui.stdin, '\r');
      assert.deepEqual(sent, []);
      assert.match(ui.lastFrame() ?? '', /must be\s+string/);
      await press(ui.stdin, '\u007f'.repeat(invalid.length));
      const content = { [property]: '123' };
      await press(ui.stdin, `\u001b[200~${JSON.stringify(content)}\u001b[201~`);
      await press(ui.stdin, '\r');
      assert.deepEqual(sent, [{ decision: 'accept', content }]);
    } finally {
      await unmount(ui);
    }
  });

test('an MCP form whose schema cannot be compiled says so instead of blaming the answer', async () => {
  const sent: UserResponse[] = [];

  const ui = await mountRequest(
    {
      id: 'form',
      kind: 'elicitation',
      title: 'Contact',
      detail: 'MCP server',
      schema: {
        type: 'object',
        properties: { name: { type: 'string', pattern: '[' } },
      },
    },
    (response) => sent.push(response),
  );

  try {
    await ready();
    await press(ui.stdin, '\r');
    assert.deepEqual(sent, []);
    const frame = ui.lastFrame() ?? '';
    assert.match(frame, /The request's schema can't be used: Invalid regular/);
    assert.doesNotMatch(frame, /matching the requested fields/);
  } finally {
    await unmount(ui);
  }
});

test('an MCP form whose schema names draft-07 validates the answer', async () => {
  const sent: UserResponse[] = [];

  const ui = await mountRequest(
    {
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
    (response) => sent.push(response),
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

test('a validation error quoting a schema property name cannot carry a link of its own', async () => {
  const ui = await mountRequest(
    {
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
    () => {},
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

test('browser elicitation confirms without JSON form content', async () => {
  const sent: UserResponse[] = [];

  const ui = await mountRequest(
    {
      id: 'url',
      kind: 'elicitation',
      title: 'Connect',
      detail: 'MCP server',
      url: 'https://example.com/connect',
    },
    (response) => sent.push(response),
    80,
    20,
  );

  try {
    await ready();
    await press(ui.stdin, '\r');
    assert.deepEqual(sent, [{ decision: 'accept', content: undefined }]);
  } finally {
    await unmount(ui);
  }
});

test('Ctrl+Shift+A leaves the cursor where Ctrl+A moves it home, and Shift+← moves it unless something else takes Shift+arrows', async () => {
  const typed = async (keys: string[], shiftArrows?: () => boolean) => {
    let sent = '';

    const ui = await mount(
      createElement(Input, {
        width: 60,
        height: 4,
        active: true,
        shiftArrows,
        onSubmit: (value: string) => {
          sent = value;

          return true;
        },
      }),
    );

    try {
      for (const data of ['xy', ...keys, 'z', '\r'])
        await press(ui.stdin, data);

      return sent;
    } finally {
      await unmount(ui);
    }
  };

  assert.equal(await typed(['\u0001']), 'zxy');
  assert.equal(await typed(['\u001b[97;6u']), 'xyz');
  assert.equal(await typed(['\u001b[1;2D']), 'xzy');
  assert.equal(await typed(['\u001b[1;2D'], () => true), 'xyz');
  assert.equal(await typed(['\u001b[1;2D'], () => false), 'xzy');
});

// Ghostty 1.3.1 sends a modifier's own report before the key, and turns Cmd+←, Cmd+→, Cmd+Delete, Option+← and Option+→ into legacy bytes
const CMD = '\u001b[57444;9u';
const OPT = '\u001b[57443;3u';
const CMD_LEFT = [CMD, '\u0001'];
const CMD_RIGHT = [CMD, '\u0005'];
const CMD_DELETE = [CMD, '\u0015'];
const OPT_LEFT = [OPT, '\u001bb'];
const OPT_RIGHT = [OPT, '\u001bf'];
const OPT_DELETE = [OPT, '\u001b[127;3u'];
const OPT_FORWARD_DELETE = [OPT, '\u001b[3;3~'];

test('Cmd and Option keys edit by line and word as Ghostty sends them, and a secret answer ignores Option', async () => {
  const sent: string[] = [];

  const onSubmit = (value: string) => {
    sent.push(value);

    return true;
  };

  const submit = async (
    ui: Awaited<ReturnType<typeof mount>>,
    text: string,
    reads: string[],
  ) => {
    await press(ui.stdin, `\u001b[200~${text}\u001b[201~`);

    for (const data of reads) await press(ui.stdin, data);

    await press(ui.stdin, '\r');

    return sent.at(-1);
  };

  const ui = await mount(
    createElement(Input, { width: 60, height: 4, active: true, onSubmit }),
  );

  try {
    for (const [reads, expected] of [
      [[...OPT_LEFT, ...OPT_LEFT, ...OPT_RIGHT, 'X'], 'one twoX three'],
      [[...CMD_LEFT, 'X'], 'Xone two three'],
      [[...OPT_DELETE, 'X'], 'one two X'],
      [[...OPT_LEFT, ...OPT_LEFT, ...OPT_FORWARD_DELETE], 'one  three'],
      [[...OPT_LEFT, ...CMD_DELETE], 'three'],
    ] as const)
      assert.equal(await submit(ui, 'one two three', [...reads]), expected);

    // the last row keeps its trailing spaces
    assert.equal(
      await submit(ui, 'one two  ', [...CMD_LEFT, ...CMD_RIGHT, 'X']),
      'one two  X',
    );

    // control bytes sharing one read insert nothing, and a tab or line break among them stays
    assert.equal(
      await submit(ui, 'ab', ['\u0015\t\n\r\u0015', 'x']),
      'ab\t\n\nx',
    );

    // Ctrl+X, Option+K and Cmd+K
    assert.equal(
      await submit(ui, 'one two three', [
        '\u001b[120;5u',
        OPT,
        '\u001b[107;3u',
        CMD,
        '\u001b[107;9u',
      ]),
      'one two three',
    );
  } finally {
    await unmount(ui);
  }

  const secret = await mount(
    createElement(Input, {
      width: 60,
      height: 4,
      active: true,
      secret: true,
      onSubmit,
    }),
  );

  try {
    assert.equal(await submit(secret, 'ab cd', [...OPT_LEFT, 'X']), 'ab cdX');

    // masked, the tab takes one cell and no space is a break, so the first row ends at 60 inside the eighth word
    assert.equal(
      await submit(secret, '\t' + 'abcdefg '.repeat(8), [
        ...Array<string>(8).fill('\u001b[D'),
        ...CMD_RIGHT,
        'X',
      ]),
      '\t' + 'abcdefg '.repeat(7) + 'abcXdefg ',
    );
  } finally {
    await unmount(secret);
  }
});

test('Cmd+Delete clears one wrapped row a press, then joins the line to the one above', async () => {
  const values: string[] = [];

  const ui = await mount(
    createElement(Input, {
      width: 12,
      height: 6,
      active: true,
      onChange: (value) => values.push(value),
      onSubmit: () => true,
    }),
  );

  try {
    await press(ui.stdin, '\u001b[200~x\n\tab cd ef gh ij kl mn\u001b[201~');

    // the tab takes eight cells, so the second line wraps after `ab ` and `ij `
    assert.deepEqual(ui.lastFrame()?.split('\n').slice(0, 4), [
      'x',
      '        ab',
      'cd ef gh ij',
      'kl mn',
    ]);

    const after: string[] = [];

    for (let count = 0; count < 4; count++) {
      for (const data of CMD_DELETE) await press(ui.stdin, data);

      after.push(values.at(-1)!);
    }

    assert.deepEqual(after, ['x\n\tab cd ef gh ij ', 'x\n\tab ', 'x\n', 'x']);
  } finally {
    await unmount(ui);
  }
});

test('Cmd+Delete with the cursor inside a restored C1 sequence deletes to the row start', async () => {
  const values: string[] = [];

  const ui = await mount(
    createElement(Input, {
      width: 10,
      height: 4,
      active: true,
      initialValue: 'ab\u009b31m\nx',
      onChange: (value) => values.push(value),
      onSubmit: () => true,
    }),
  );

  try {
    // after U+009B on this nonfinal line, the cursor sits past every drawn row
    for (const data of [...Array<string>(5).fill('\u001b[D'), ...CMD_DELETE])
      await press(ui.stdin, data);

    assert.equal(values.at(-1), '31m\nx');
  } finally {
    await unmount(ui);
  }
});

test('Cmd+← and Cmd+Delete inside a restored C1 sequence never pass the cursor', async () => {
  const changes: [string, number][] = [];
  const value = 'abcd\u009b31mxyz';

  const ui = await mount(
    createElement(Input, {
      width: 4,
      height: 4,
      active: true,
      initialValue: value,
      onChange: (value, cursor) => changes.push([value, cursor]),
      onSubmit: () => true,
    }),
  );

  const after = async (reads: readonly string[]) => {
    for (const data of reads) await press(ui.stdin, data);

    return changes.at(-1);
  };

  try {
    // with the cursor after U+009B, a prefix cut after `3` or `31` strips as a whole sequence and draws shorter
    assert.deepEqual(
      await after([...Array<string>(6).fill('\u001b[D'), ...CMD_LEFT]),
      [value, 5],
    );

    assert.deepEqual(await after(CMD_DELETE), [value, 5]);
  } finally {
    await unmount(ui);
  }
});

test('Cmd+← and Cmd+→ stop at the edges of the wrapped row the cursor is drawn on', async () => {
  const mounted: { unmount: () => void }[] = [];

  const typed = async (width: number, text: string) => {
    const cursors: number[] = [];

    const ui = await mount(
      createElement(Input, {
        width,
        height: 6,
        active: true,
        onChange: (_value, cursor) => cursors.push(cursor),
        onSubmit: () => true,
      }),
    );

    mounted.push(ui);
    await press(ui.stdin, `\u001b[200~${text}\u001b[201~`);

    const after = async (reads: readonly string[]) => {
      for (const data of reads) await press(ui.stdin, data);

      return cursors.at(-1);
    };

    return { frame: () => ui.lastFrame()?.split('\n'), after };
  };

  const left = (count: number) => Array<string>(count).fill('\u001b[D');

  try {
    // x0 \n1 \t2 a3 b4 ·5 c6 d7 ·8 e9 f10 ·11 g12 h13 ·14 i15 j16 ·17 k18 … n22
    const tab = await typed(12, 'x\n\tab cd ef gh ij kl mn');

    assert.deepEqual(tab.frame()?.slice(0, 4), [
      'x',
      '        ab',
      'cd ef gh ij',
      'kl mn',
    ]);

    assert.equal(await tab.after(CMD_LEFT), 18);
    // the start of a row stays put rather than reaching the row above
    assert.equal(await tab.after(CMD_LEFT), 18);
    assert.equal(await tab.after(CMD_RIGHT), 23);
    // a soft row ends before its trailing space, past which the cursor is drawn on the next row
    assert.equal(await tab.after([...left(9), ...CMD_RIGHT]), 17);
    assert.equal(await tab.after(CMD_LEFT), 6);
    assert.equal(await tab.after([...left(2), ...CMD_LEFT]), 2);
    assert.equal(await tab.after(CMD_RIGHT), 5);
    // a word longer than the row breaks with no space to stop before, and wide characters fill it at five
    const long = await typed(10, '中'.repeat(8));
    assert.deepEqual(long.frame()?.slice(0, 2), ['中中中中中', '中中中']);
    assert.equal(await long.after(CMD_LEFT), 5);
    assert.equal(await long.after([...left(1), ...CMD_RIGHT]), 5);
    // the tab's cells span the row break, and the row that starts inside it takes the whole tab
    const split = await typed(6, 'abcd\tx');
    assert.deepEqual(split.frame()?.slice(0, 2), ['abcd', '  x']);
    assert.equal(await split.after(CMD_LEFT), 4);
    // a full-width line above another gets no cursor cell, so its end is drawn on its own row
    const full = await typed(10, 'abcdefghij\nx');
    assert.deepEqual(full.frame()?.slice(0, 2), ['abcdefghij', 'x']);
    assert.equal(await full.after([...left(2), ...CMD_LEFT]), 0);
    assert.equal(await full.after(CMD_RIGHT), 10);
    // the cursor cell after a full last row wraps onto a row of its own, so the full row ends before its trailing space
    const last = await typed(10, 'abcdefghi ');
    assert.equal(await last.after([...left(3), ...CMD_RIGHT]), 9);
    // inside a row's trailing spaces, Cmd+→ never moves left
    const spaced = await typed(10, 'abcdef    ghij kl');
    assert.deepEqual(spaced.frame()?.slice(0, 2), ['abcdef', 'ghij kl']);

    assert.equal(
      await spaced.after([...CMD_LEFT, ...left(2), ...CMD_RIGHT]),
      8,
    );

    assert.equal(await spaced.after([...left(5), ...CMD_RIGHT]), 6);
  } finally {
    for (const ui of mounted) await unmount(ui);
  }
});

test('a shell prompt draws its ! apart from the text, keeps the cursor after it, and a delete at the text start takes it', async () => {
  const sent: string[] = [];

  const ui = await mount(
    createElement(Input, {
      width: 12,
      height: 4,
      active: true,
      shell: true,
      onSubmit: (value) => {
        sent.push(value);

        return true;
      },
    }),
  );

  const submit = async (text: string, reads: string[]) => {
    await press(ui.stdin, `\u001b[200~${text}\u001b[201~`);

    for (const data of reads) await press(ui.stdin, data);

    await press(ui.stdin, '\r');

    return sent.at(-1);
  };

  try {
    await press(ui.stdin, '\u001b[200~!abcdefghijk\u001b[201~');

    // the text has the 10 cells beside the `!`, so it wraps there and its second row starts under it
    assert.deepEqual(ui.lastFrame()?.split('\n').slice(0, 2), [
      '! abcdefghij',
      '  k',
    ]);

    await press(ui.stdin, '\r');

    for (const [reads, expected] of [
      [['\u001b[H', 'x'], '!xabcdefghijk'],
      [[...CMD_LEFT, 'x'], '!abcdefghijxk'],
      [['\u001b[H', '\u007f'], 'abcdefghijk'],
      [['\u001b[H', ...OPT_DELETE], 'abcdefghijk'],
      [['\u001b[H', ...CMD_DELETE], 'abcdefghijk'],
    ] as const)
      assert.equal(await submit('!abcdefghijk', [...reads]), expected);
  } finally {
    await unmount(ui);
  }
});
