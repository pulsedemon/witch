import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { test, vi } from 'vitest';
import { setImmediate as tick } from 'node:timers/promises';
import { proposedDiff, reportedDiff } from '../../../src/agents/claude/diff.js';
import type { AgentEvent, UserRequest } from '../../../src/agents/types.js';
import { fixture } from '../../fixtures/claude-adapter.js';
import { scratch } from '../../fixtures/scratch.js';
import { until, within } from '../../fixtures/within.js';

test('reported home paths keep repeated separators under home', () => {
  assert.deepEqual(
    reportedDiff(
      {
        filePath: '~//note.txt',
        type: 'create',
        content: 'x',
        structuredPatch: [],
      },
      '/work',
    ),
    [
      {
        path: join(homedir(), 'note.txt'),
        kind: 'add',
        hunks: [{ oldStart: 0, newStart: 1, lines: ['+x'] }],
      },
    ],
  );
});

const examples = [
  {
    name: 'literal replacement',
    tool: 'Edit',
    original: 'old\n',
    input: { old_string: 'old', new_string: '$& $1' },
    kind: 'update',
    oldStart: 1,
    newStart: 1,
    lines: ['-old', '+$& $1'],
  },
  {
    name: 'line deletion',
    tool: 'Edit',
    original: 'one\ntwo\nthree\n',
    input: { old_string: 'two', new_string: '' },
    kind: 'update',
    oldStart: 1,
    newStart: 1,
    lines: [' one', '-two', ' three'],
  },
  {
    name: 'replace all',
    tool: 'Edit',
    original: 'old\nold\n',
    input: { old_string: 'old', new_string: 'new', replace_all: true },
    kind: 'update',
    oldStart: 1,
    newStart: 1,
    lines: ['-old', '-old', '+new', '+new'],
  },
  {
    name: 'smart quotes',
    tool: 'Edit',
    original: 'const x = “old”;\n',
    input: { old_string: 'const x = "old";', new_string: 'const x = "new";' },
    kind: 'update',
    oldStart: 1,
    newStart: 1,
    lines: ['-const x = “old”;', '+const x = “new”;'],
  },
  {
    name: 'escaped input',
    tool: 'Edit',
    original: 'const x = "café";\n',
    input: {
      old_string: String.raw`caf\u00e9`,
      new_string: String.raw`caf\u00e8`,
    },
    kind: 'update',
    oldStart: 1,
    newStart: 1,
    lines: ['-const x = "café";', '+const x = "cafè";'],
  },
  {
    name: 'escaped file',
    tool: 'Edit',
    original: String.raw`const x = "caf\u00E9";` + '\n',
    input: { old_string: 'café', new_string: 'cafè' },
    kind: 'update',
    oldStart: 1,
    newStart: 1,
    lines: [
      String.raw`-const x = "caf\u00E9";`,
      String.raw`+const x = "caf\u00E8";`,
    ],
  },
  {
    name: 'Write creation',
    tool: 'Write',
    original: null,
    input: { content: 'created\n' },
    kind: 'add',
    oldStart: 0,
    newStart: 1,
    lines: ['+created'],
  },
  {
    name: 'Edit creation',
    tool: 'Edit',
    original: null,
    input: { old_string: '', new_string: 'created\n' },
    kind: 'add',
    oldStart: 0,
    newStart: 1,
    lines: ['+created'],
  },
  {
    name: 'whitespace Edit creation',
    tool: 'Edit',
    original: ' \n',
    input: { old_string: '', new_string: 'created\n' },
    kind: 'add',
    oldStart: 0,
    newStart: 1,
    lines: ['+created'],
  },
  {
    name: 'Write overwrite',
    tool: 'Write',
    original: 'before\n',
    input: { content: 'after\n' },
    kind: 'update',
    oldStart: 1,
    newStart: 1,
    lines: ['-before', '+after'],
  },
  {
    name: 'empty existing Write',
    tool: 'Write',
    original: '',
    input: { content: 'after\n' },
    kind: 'update',
    oldStart: 1,
    newStart: 1,
    lines: ['+after'],
  },
  {
    name: 'Write BOM and CRLF',
    tool: 'Write',
    original: '\uFEFFbefore\r\n',
    input: { content: 'after\n' },
    kind: 'update',
    oldStart: 1,
    newStart: 1,
    lines: ['-\uFEFFbefore', '+\uFEFFafter'],
  },
  {
    name: 'Edit BOM and CRLF',
    tool: 'Edit',
    original: '\uFEFFone\r\ntwo\r\n',
    input: { old_string: 'two', new_string: 'TWO' },
    kind: 'update',
    oldStart: 1,
    newStart: 1,
    lines: [' \uFEFFone', '-two', '+TWO'],
  },
] as const;

for (const example of examples)
  test(`Claude previews preserve ${example.name} without writing`, async () => {
    const cwd = await scratch('witch-claude-preview-');
    const path = join(cwd, 'file.txt');

    if (example.original !== null) await fs.writeFile(path, example.original);

    const input = { file_path: 'file.txt', ...example.input };
    const before = structuredClone(input);

    const diff = await proposedDiff(
      example.tool,
      input,
      cwd,
      new AbortController().signal,
    );

    assert.deepEqual(
      diff?.map(({ path, kind, hunks }) => ({
        path,
        kind,
        hunks: hunks.map(({ oldStart, newStart, lines }) => ({
          oldStart,
          newStart,
          lines,
        })),
      })),
      [
        {
          path,
          kind: example.kind,
          hunks: [
            {
              oldStart: example.oldStart,
              newStart: example.newStart,
              lines: example.lines,
            },
          ],
        },
      ],
    );

    assert.deepEqual(input, before);

    if (example.original === null)
      await assert.rejects(fs.access(path), { code: 'ENOENT' });
    else assert.equal(await fs.readFile(path, 'utf8'), example.original);
  });

test('previews preserve quote styles without stalling on long replacements', async () => {
  const cwd = await scratch('witch-claude-preview-');
  const path = join(cwd, 'quotes.txt');

  for (const [opening, straight, other, replacement] of [
    ['‘', "'", '"', '‘changed’'],
    ['“', '"', "'", '“changed”'],
  ] as const) {
    const tail = other.repeat(128000);
    await fs.writeFile(path, opening + tail + '\n');
    const started = performance.now();

    const diff = await proposedDiff(
      'Edit',
      {
        file_path: path,
        old_string: straight + tail,
        new_string: straight + 'changed' + straight + tail,
      },
      cwd,
      new AbortController().signal,
    );

    const elapsed = performance.now() - started;

    assert.deepEqual(diff?.[0]?.hunks[0]?.lines, [
      '-' + opening + tail,
      '+' + replacement + tail,
    ]);

    assert.ok(elapsed < 1000, `quote preview took ${elapsed} ms`);
  }
});

test('replace_all previews both distant changes', async () => {
  const cwd = await scratch('witch-claude-preview-');
  const path = join(cwd, 'distant.txt');

  await fs.writeFile(
    path,
    'old\none\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\nold\n',
  );

  const diff = await proposedDiff(
    'Edit',
    {
      file_path: path,
      old_string: 'old',
      new_string: 'new',
      replace_all: true,
    },
    cwd,
    new AbortController().signal,
  );

  assert.deepEqual(
    diff?.[0]?.hunks.map(({ oldStart, newStart, lines }) => ({
      oldStart,
      newStart,
      lines,
    })),
    [
      {
        oldStart: 1,
        newStart: 1,
        lines: ['-old', '+new', ' one', ' two', ' three'],
      },
      {
        oldStart: 9,
        newStart: 9,
        lines: [' eight', ' nine', ' ten', '-old', '+new'],
      },
    ],
  );
});

test('a diff deadline yields no partial preview', async () => {
  const cwd = await scratch('witch-claude-preview-');
  const path = join(cwd, 'deadline.txt');
  await fs.writeFile(path, 'before\n');
  let calls = 0;

  const clock = vi
    .spyOn(Date, 'now')
    .mockImplementation(() => (calls++ === 0 ? 0 : 6000));

  try {
    assert.equal(
      await proposedDiff(
        'Write',
        { file_path: path, content: 'after\n' },
        cwd,
        new AbortController().signal,
      ),
      undefined,
    );
  } finally {
    clock.mockRestore();
  }

  assert.equal(await fs.readFile(path, 'utf8'), 'before\n');
});

test('unpreviewable requests retain approval behavior and original inputs', async () => {
  const requests: UserRequest[] = [];

  const { session, cwd } = await fixture((event) => {
    if (event.type === 'request') {
      requests.push(event.request);
      session.respond(event.request.id, { decision: 'accept' });
    }
  });

  const path = join(cwd, 'file.txt');
  const denied = join(cwd, 'denied.txt');
  const read = fs.readFile;

  vi.spyOn(fs, 'readFile').mockImplementation(
    (...args: Parameters<typeof fs.readFile>) => {
      if (String(args[0]) === denied)
        return Promise.reject(
          Object.assign(new Error('unreadable'), { code: 'EACCES' }),
        );

      return read(...args);
    },
  );

  try {
    await fs.writeFile(path, 'twice twice');
    await fs.writeFile(denied, 'kept');
    const binary = join(cwd, 'binary');
    await fs.writeFile(binary, Buffer.from([255]));

    const cases = [
      {
        tool: 'Edit',
        input: { file_path: path, old_string: 'twice', new_string: 'once' },
      },
      {
        tool: 'Edit',
        input: {
          file_path: join(cwd, 'missing-edit'),
          old_string: 'missing',
          new_string: 'next',
        },
      },
      { tool: 'Write', input: { file_path: cwd, content: 'not a file' } },
      { tool: 'Write', input: { file_path: denied, content: 'not readable' } },
      {
        tool: 'Write',
        input: { file_path: binary, content: 'unsupported encoding' },
      },
      { tool: 'Bash', input: { file_path: path, command: 'echo untouched' } },
    ];

    for (const proposal of cases) {
      await fs.writeFile(join(cwd, 'preview.json'), JSON.stringify(proposal));
      await session.send('preview');
      assert.equal(requests.at(-1)?.diff, undefined);

      assert.deepEqual(
        JSON.parse(await read(join(cwd, 'response.json'), 'utf8')).updatedInput,
        proposal.input,
      );
    }

    const input = { file_path: join(cwd, 'missing-write'), content: 'new\n' };

    await fs.writeFile(
      join(cwd, 'preview.json'),
      JSON.stringify({ tool: 'Write', input }),
    );

    await session.send('preview');
    assert.equal(requests.at(-1)?.diff?.[0]?.kind, 'add');

    assert.deepEqual(
      JSON.parse(await read(join(cwd, 'response.json'), 'utf8')).updatedInput,
      input,
    );

    assert.equal(await read(path, 'utf8'), 'twice twice');
    assert.equal(await read(denied, 'utf8'), 'kept');
  } finally {
    await session.close();
  }
});

for (const action of ['withdraw', 'close'] as const)
  test(`preview ${action} publishes no request or resolution after cancellation`, async () => {
    const events: AgentEvent[] = [];
    const { session, cwd } = await fixture((event) => events.push(event));
    const path = join(cwd, 'pending.txt');
    await fs.writeFile(path, 'before\n');

    await fs.writeFile(
      join(cwd, 'preview.json'),
      JSON.stringify({
        tool: 'Write',
        input: { file_path: path, content: 'after\n' },
      }),
    );

    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const stat = fs.stat;

    vi.spyOn(fs, 'stat').mockImplementation(
      async (...args: Parameters<typeof fs.stat>) => {
        const result = await stat(...args);

        if (String(args[0]) === path) {
          entered.resolve();
          await release.promise;
        }

        return result;
      },
    );

    try {
      const turn = session.send(
        action === 'withdraw' ? 'preview-withdrawn' : 'preview',
      );

      await within(entered.promise, 2000, 'preview read');

      if (action === 'withdraw')
        await fs.writeFile(join(cwd, 'withdraw-preview'), 'yes');
      else await within(session.close(), 2000, 'close during preview');

      await within(turn, 2000, 'cancelled turn');
      release.resolve();
      await tick();
      await tick();

      assert.deepEqual(
        events.filter(
          (event) =>
            event.type === 'request' || event.type === 'request-resolved',
        ),
        [],
      );

      assert.equal(await fs.readFile(path, 'utf8'), 'before\n');
    } finally {
      release.resolve();
      await session.close();
    }
  });

test('a previewed approval passes the original decision and input', async () => {
  const events: AgentEvent[] = [];
  const { session, cwd } = await fixture((event) => events.push(event));
  const path = join(cwd, 'original.txt');

  const input = {
    file_path: path,
    old_string: 'old',
    new_string: '$&',
    replace_all: false,
  };

  await fs.writeFile(path, 'old\n');

  await fs.writeFile(
    join(cwd, 'preview.json'),
    JSON.stringify({ tool: 'Edit', input }),
  );

  try {
    for (const decision of ['accept', 'decline'] as const) {
      events.length = 0;
      const turn = session.send('preview');

      await until('previewed request', () =>
        events.some((event) => event.type === 'request'),
      );

      const request = events.find((event) => event.type === 'request');
      assert.ok(request?.type === 'request');

      assert.deepEqual(request.request.diff?.[0]?.hunks[0]?.lines, [
        '-old',
        '+$&',
      ]);

      assert.equal(await fs.readFile(path, 'utf8'), 'old\n');
      session.respond(request.request.id, { decision });
      await within(turn, 2000, 'decision');

      const response = JSON.parse(
        await fs.readFile(join(cwd, 'response.json'), 'utf8'),
      ) as { behavior: string; updatedInput?: unknown };

      assert.equal(response.behavior, decision === 'accept' ? 'allow' : 'deny');

      if (decision === 'accept') assert.deepEqual(response.updatedInput, input);
    }
  } finally {
    await session.close();
  }
});
