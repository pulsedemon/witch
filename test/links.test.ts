import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { test } from 'vitest';
import { promisify } from 'node:util';
import { styledCharsFromTokens, tokenize } from '@alcalzone/ansi-tokenize';
import stripAnsi from 'strip-ansi';
import wrapAnsi from 'wrap-ansi';
import {
  hyperlink,
  linkify,
  linkifyAppend,
  linkTarget,
  plain,
} from '../src/ui/links.js';
import { markdown } from '../src/ui/markdown.js';

const execute = promisify(execFile);

function linkSpans(text: string) {
  const spans: { target: string; text: string }[] = [];
  let current: (typeof spans)[number] | undefined;
  for (const { value, styles } of styledCharsFromTokens(tokenize(text))) {
    const target = styles
      .find(({ code }) => code.startsWith('\u001b]8;;'))
      ?.code.slice(5, -1);
    if (!target) current = undefined;
    else if (current?.target === target) current.text += value;
    else {
      current = { target, text: value };
      spans.push(current);
    }
  }
  return spans;
}

test('bare URLs retain their exact browser target across wrapping', () => {
  const url = 'https://iterm2.com/documentation-escape-codes.html';
  const rendered = wrapAnsi(linkify(`Read ${url}.`, '/work'), 24, {
    hard: true,
  });
  assert.ok(rendered.includes(`\u001b]8;;${url}\u0007`));
  assert.equal(stripAnsi(rendered).replaceAll('\n', ''), `Read ${url}.`);
  for (const row of rendered.split('\n')) {
    const linked = styledCharsFromTokens(tokenize(row)).filter(({ styles }) =>
      styles.some(({ code }) => code === `\u001b]8;;${url}\u0007`),
    );
    assert.ok(linked.length, row);
    assert.ok(
      linked.every(({ styles }) =>
        styles.some(({ code }) => code === '\u001b[4m'),
      ),
      row,
    );
  }
});

test('a link is underlined inside its OSC 8 sequence on each of its lines, and a target that cannot open stays plain text', () => {
  const link = (text: string) =>
    `\u001b]8;;https://example.com\u0007\u001b[4m${text}\u001b[24m\u001b]8;;\u0007`;
  assert.equal(
    hyperlink('label', 'https://example.com', '/work'),
    link('label'),
  );
  assert.equal(
    hyperlink('foo\nbar', 'https://example.com', '/work'),
    `${link('foo')}\n${link('bar')}`,
  );
  assert.equal(hyperlink('label', 'smb://example.com/share', '/work'), 'label');
});

test('a link stays plain OSC 8 when Witch runs under tmux', async () => {
  const links = new URL('../src/ui/links.ts', import.meta.url).href;
  const { stdout } = await execute(
    process.execPath,
    [
      '--import',
      import.meta.resolve('tsx'),
      '--input-type=module',
      '-e',
      `import { hyperlink } from ${JSON.stringify(links)}; process.stdout.write(hyperlink('label', 'https://example.com', '/work'))`,
    ],
    {
      env: {
        ...process.env,
        TMUX: '/private/tmp/tmux-501/default,1,0',
        TERM: 'tmux-256color',
      },
    },
  );
  assert.equal(
    stdout,
    '\u001b]8;;https://example.com\u0007\u001b[4mlabel\u001b[24m\u001b]8;;\u0007',
  );
});

test('relative files resolve against their originating project with encoded spaces and locations', () => {
  assert.equal(
    linkTarget('src/My File.ts:12:4', '/work/My Project'),
    'vscode://file/work/My%20Project/src/My%20File.ts:12:4',
  );
  assert.equal(
    linkTarget('/work/other.ts:7', '/work/My Project'),
    'vscode://file/work/other.ts:7',
  );
  assert.equal(
    linkTarget('~//note.txt:12:4', '/work/My Project'),
    `vscode://file${homedir().split('/').map(encodeURIComponent).join('/')}/note.txt:12:4`,
  );
  assert.ok(
    linkify('See src/main.ts:42 and README.md.', '/work/project').includes(
      'vscode://file/work/project/src/main.ts:42',
    ),
  );
});

test('non-ASCII and punctuation filenames link whole', () => {
  for (const [text, target] of [
    ['docs/über/x.md', 'vscode://file/proj/docs/%C3%BCber/x.md'],
    ['src/naïve.ts:3', 'vscode://file/proj/src/na%C3%AFve.ts:3'],
    ['docs/my-file+v2.ts', 'vscode://file/proj/docs/my-file%2Bv2.ts'],
    ['docs/my,file.ts', 'vscode://file/proj/docs/my%2Cfile.ts'],
    ['résumé.md', 'vscode://file/proj/r%C3%A9sum%C3%A9.md'],
    ['my%20file.ts', 'vscode://file/proj/my%2520file.ts'],
    [
      'docs/re\u0301sume\u0301.md',
      'vscode://file/proj/docs/re%CC%81sume%CC%81.md',
    ],
  ] as const) {
    for (const render of [linkify, markdown]) {
      const rendered = render(text, '/proj');
      assert.equal(stripAnsi(rendered), text);
      assert.deepEqual(linkSpans(rendered), [{ target, text }], text);
    }
  }
});

test('bare file URLs do not produce relative suffix links', () => {
  for (const text of [
    'at file:///Users/me/My%20Project/src/a.ts:12:3',
    'file:///Users/me/My%20Project/README.md',
    'file:///Users/me/src/a.ts:12:3',
  ]) {
    assert.equal(linkify(text, '/proj'), text);
    assert.equal(markdown(text, '/proj'), text);
  }
});

test('filename boundaries preserve prose and complete names', () => {
  for (const [text, expected] of [
    [
      'Edited src/naïve.ts:3',
      [
        {
          target: 'vscode://file/proj/src/na%C3%AFve.ts:3',
          text: 'src/naïve.ts:3',
        },
      ],
    ],
    [
      '"über/x.md"',
      [{ target: 'vscode://file/proj/%C3%BCber/x.md', text: 'über/x.md' }],
    ],
    [
      'src/a.ts, src/b.ts',
      [
        { target: 'vscode://file/proj/src/a.ts', text: 'src/a.ts' },
        { target: 'vscode://file/proj/src/b.ts', text: 'src/b.ts' },
      ],
    ],
    [
      'README.md...',
      [{ target: 'vscode://file/proj/README.md', text: 'README.md' }],
    ],
    [
      'résumé.md,,',
      [{ target: 'vscode://file/proj/r%C3%A9sum%C3%A9.md', text: 'résumé.md' }],
    ],
    [
      'src/a.ts...',
      [{ target: 'vscode://file/proj/src/a.ts', text: 'src/a.ts' }],
    ],
    ['src/a.ts+draft', []],
    [
      'https://example.com/my+file.ts',
      [
        {
          target: 'https://example.com/my+file.ts',
          text: 'https://example.com/my+file.ts',
        },
      ],
    ],
  ] as const) {
    for (const render of [linkify, markdown]) {
      const rendered = render(text, '/proj');
      assert.equal(stripAnsi(rendered), text);
      assert.deepEqual(linkSpans(rendered), expected, text);
    }
  }
});

test('a non-ASCII filename keeps its whole target through appends and wrapping', () => {
  const first = linkifyAppend('docs/', '/proj');
  const next = linkifyAppend(
    first.pending + 'über/x.md\n',
    '/proj',
    first.target,
  );
  const text = next.complete.join('\n');
  const target = 'vscode://file/proj/docs/%C3%BCber/x.md';
  assert.equal(stripAnsi(text), 'docs/über/x.md');
  assert.deepEqual(linkSpans(text), [{ target, text: 'docs/über/x.md' }]);
  assert.equal(next.tail, '');
  assert.equal(next.pending, '');
  const rows = wrapAnsi(text, 8, { hard: true, trim: false }).split('\n');
  assert.deepEqual(rows.map(linkSpans), [
    [{ target, text: 'docs/übe' }],
    [{ target, text: 'r/x.md' }],
  ]);
  assert.equal(stripAnsi(rows.join('')), 'docs/über/x.md');
});

test('a prefixed or absolute path followed by a colon links without it, keeping a line and column', () => {
  for (const [text, target] of [
    ['./src/a.ts:12:const x = 1;', 'vscode://file/work/project/src/a.ts:12'],
    ['/work/src/b.c:7:5: error: bad', 'vscode://file/work/src/b.c:7:5'],
    ['- Fix in /work/other: memory conflicts', 'vscode://file/work/other'],
  ] as const)
    assert.ok(
      linkify(text, '/work/project').includes(`\u001b]8;;${target}\u0007`),
      text,
    );
});

test('a #L location links as a line and column, a heading fragment drops, and a Markdown target with no file stays text', () => {
  assert.ok(
    linkify('`src/a.ts#L10C2`', '/work').includes(
      '\u001b]8;;vscode://file/work/src/a.ts:10:2\u0007',
    ),
  );
  assert.ok(
    linkify('see server.py#L4C2', '/work').includes(
      '\u001b]8;;vscode://file/work/server.py:4:2\u0007',
    ),
  );
  assert.ok(
    markdown('[Rules](docs/rules.md#shared-memory)', '/work').includes(
      '\u001b]8;;vscode://file/work/docs/rules.md\u0007',
    ),
  );
  assert.ok(
    markdown('[Src](src/a.ts#L10C2)', '/work').includes(
      '\u001b]8;;vscode://file/work/src/a.ts:10:2\u0007',
    ),
  );
  for (const target of ['', '#goal', '#L10'])
    assert.ok(
      !markdown(`[Top](${target})`, '/work').includes('\u001b]8;;vscode'),
      target,
    );
});

test('Markdown labels and links in code blocks remain clickable', () => {
  const rendered = markdown(
    '[Documentation](https://example.com/docs)\n\n```text\nhttps://example.com/log\nsrc/main.ts:42\n```',
    '/work/project',
  );
  assert.match(stripAnsi(rendered), /Documentation/);
  for (const target of [
    'https://example.com/docs',
    'https://example.com/log',
    'vscode://file/work/project/src/main.ts:42',
  ])
    assert.ok(rendered.includes(target));
});

test('long URLs and preexisting terminal hyperlinks keep their targets, and a file URL opens in VS Code', () => {
  const url = `https://example.com/search?q=${'x'.repeat(1000)}`;
  assert.ok(linkify(url, '/work').includes(`\u001b]8;;${url}\u0007`));
  const explicit =
    '\u001b]8;;https://example.com\u0007Friendly label\u001b]8;;\u0007';
  assert.ok(linkify(explicit, '/work').includes('https://example.com'));
  assert.equal(stripAnsi(linkify(explicit, '/work')), 'Friendly label');
  for (const [target, url] of [
    ['file:///work/My%20File.ts', 'vscode://file/work/My%20File.ts'],
    ['vscode://file/work/a.ts', 'vscode://file/work/a.ts'],
  ])
    assert.ok(
      linkify(
        `\u001b]8;;${target}\u0007label\u001b]8;;\u0007`,
        '/other',
      ).includes(`\u001b]8;;${url}\u0007`),
      target,
    );
});

test('quoted and Markdown file links preserve spaces without linking command names', () => {
  const prose = '/help PageUp/PageDown ↑/↓';
  assert.equal(linkify(prose, '/work'), prose);
  for (const rendered of [
    linkify('"src/My File.ts:3:2"', '/work'),
    markdown('`src/My File.ts:3:2`', '/work'),
    markdown('[Open file](src/My%20File.ts:3:2)', '/work'),
  ]) {
    assert.ok(rendered.includes('vscode://file/work/src/My%20File.ts:3:2'));
    assert.ok(!rendered.includes('%2520'));
  }
});

test("a path dropped into a message links whole to its unescaped file, through escaped spaces and a screenshot name's U+202F", () => {
  const dropped =
    '/var/folders/T/Screenshot\\ 2026-10-26\\ at\\ 3.35.40\u202fPM.png';
  assert.deepEqual(linkSpans(markdown(`${dropped} what is this?`, '/work')), [
    {
      target:
        'vscode://file/var/folders/T/Screenshot%202026-10-26%20at%203.35.40%E2%80%AFPM.png',
      text: dropped,
    },
  ]);
});

test('bare source references take precedence over fuzzy domains while explicit web URLs stay web links', () => {
  for (const file of ['server.py:42', 'foo.sh', 'README.md', 'src/main.py:4']) {
    const rendered = linkify(file, '/work/project');
    assert.ok(rendered.includes(`vscode://file/work/project/${file}`));
    assert.ok(!rendered.includes('http://'));
  }
  for (const url of [
    'https://server.py:42',
    'https://example.com/path?file=README.md',
  ])
    assert.ok(linkify(url, '/work').includes(`\u001b]8;;${url}\u0007`));
  assert.ok(linkify('example.com', '/work').includes('http://example.com'));
});

test('a dotted word or a name with an unlisted extension and no directory stays text', () => {
  const prose = 'Use e.g. or i.e. with foo.bar.';
  assert.equal(linkify(prose, '/work'), prose);
});

test('malformed file URLs remain readable without breaking a persisted transcript', () => {
  assert.equal(
    stripAnsi(markdown('[Open report](file:///tmp/100%.txt)', '/work')),
    'Open report',
  );
  assert.equal(
    stripAnsi(
      linkify('\u001b]8;;file://%\u0007Invalid path\u001b]8;;\u0007', '/work'),
    ),
    'Invalid path',
  );
});

test('long runs of filename characters, and links on many lines or one, link in linear time', () => {
  // measure the parsing thread so other threads' CPU work cannot skew the ratio.
  const fastest = (text: string) =>
    Math.min(
      ...[1, 2, 3].map(() => {
        const start = process.threadCpuUsage();
        linkify(text, '/work');
        const { user, system } = process.threadCpuUsage(start);
        return user + system;
      }),
    );
  const links = (count: number, separator: string) =>
    Array.from(
      { length: count },
      (_, n) => `dev${n}@example.com https://example.com/${n}`,
    ).join(separator);
  // minified, as an API returns it: no whitespace to cut at
  const emails = (count: number) =>
    JSON.stringify(
      Array.from({ length: count }, (_, n) => ({
        email: `dev${n}@example.com`,
      })),
    );
  for (const [input, small, large] of [
    ...['-', '.', '@', 'é', '+', ',', '%'].map(
      (character) =>
        [character, character.repeat(16000), character.repeat(64000)] as const,
    ),
    ['lines of links', links(500, '\n'), links(2000, '\n')] as const,
    ['a line of links', links(500, ' '), links(2000, ' ')] as const,
    ['a line of JSON emails', emails(500), emails(2000)] as const,
  ]) {
    const smallTime = fastest(small);
    const largeTime = fastest(large);
    assert.ok(
      largeTime < smallTime * 8,
      `${input} took ${smallTime} µs of CPU, then ${largeTime} µs for 4x the input`,
    );
  }
});

test('text past 2000 characters is cut after a newline, else after a space, < or >, else after a quote, so a link across the cut stays whole', () => {
  const file = `src/notes ${'n'.repeat(20)}.md`;
  for (const [text, target] of [
    [
      `${'x'.repeat(1990)} https://example.com/abcdef end`,
      'https://example.com/abcdef',
    ],
    // the space inside the quotes is the last whitespace before the cut
    [
      `${'x'.repeat(1980)}\n"${file}" end`,
      `vscode://file/work/${file.replace(' ', '%20')}`,
    ],
    [
      `${'x'.repeat(1990)}<https://example.com/abcdef>end`,
      'https://example.com/abcdef',
    ],
    [
      `${'x'.repeat(1990)}"https://example.com/abcdef"]`,
      'https://example.com/abcdef',
    ],
  ] as const) {
    const output = linkify(text, '/work');
    assert.ok(output.includes(`\u001b]8;;${target}\u0007`), target);
    assert.equal(stripAnsi(output), text);
  }
  const unbroken = 'x'.repeat(5000);
  assert.equal(linkify(unbroken, '/work'), unbroken);
});

test('multi-dot names, dotfiles and quoted or prefixed paths after a dash link whole', () => {
  for (const [text, target] of [
    ['test/claude.test.ts:3', 'vscode://file/work/test/claude.test.ts:3'],
    ['.eslintrc.json', 'vscode://file/work/.eslintrc.json'],
    ['dir/.hidden.ts', 'vscode://file/work/dir/.hidden.ts'],
    ['-"src/a b.ts"', 'vscode://file/work/src/a%20b.ts'],
    ['x-~/notes.md', `vscode://file${homedir()}/notes.md`],
  ] as const)
    assert.ok(
      linkify(text, '/work').includes(`\u001b]8;;${target}\u0007`),
      text,
    );
});

test('a web target with a control character stays plain text', () => {
  assert.equal(
    hyperlink('label', 'https://example.com/\u001b]8;;x', '/work'),
    'label',
  );
  assert.equal(
    hyperlink('label', 'https://example.com/\u009d8;;smb://x\u009c', '/work'),
    'label',
  );
});

test('a stray escape or bell left by a dropped sequence cannot rejoin into a link', () => {
  const forged =
    '\u001b\u001b[31m]8;;smb://evil.example/share\u0007name\u001b\u001b[0m]8;;\u0007';
  const c1 = '\u009d8;;smb://evil.example/share\u0007name\u009d8;;\u0007';
  assert.equal(
    linkify(forged, '/work'),
    ']8;;smb://evil.example/sharename]8;;',
  );
  assert.equal(linkify(c1, '/work'), '8;;smb://evil.example/sharename8;;');
  assert.equal(linkify('a\r\nb\tc', '/work'), 'a\r\nb\tc');
});

test('plain text keeps no link, including one that stripping a sequence would build', () => {
  assert.equal(
    plain(
      '\u001b\u001b[31m]8;;https://evil.example/share\u0007name\u001b\u001b[0m]8;;\u0007',
    ),
    ']8;;https://evil.example/sharename]8;;',
  );
  assert.equal(
    plain('\u001b]8;;https://evil.example/share\u0007name\u001b]8;;\u0007'),
    'name',
  );
});

test('streaming links retain their targets and unresolved controls across chunks', () => {
  const target = 'https://x.test/';
  const cases = [
    {
      text: '\u001b]8;x\u0007\nfoo;https://x.test/\u0007one\ntwo',
      plain: 'one\ntwo',
      linked: true,
    },
    { text: 'a\r\nb\tc', plain: 'a\r\nb\tc', linked: false },
    { text: 'a😀z\n👩‍💻', plain: 'a😀z\n👩‍💻', linked: false },
    { text: '\u001b[31\nredm', plain: '[31\nredm', linked: false },
    ...['\u0007', '\u009c', '\u001b\\'].flatMap((end) => [
      {
        text: `before\n\u001b]8;;${target}${end}one\ntwo\u001b]8;;${end}\nafter`,
        plain: 'before\none\ntwo\nafter',
        linked: true,
      },
      {
        text: `before\n\u001b]0;title\nhidden${end}one\ntwo`,
        plain: 'before\none\ntwo',
        linked: false,
      },
      {
        text: `before\n\u009b]0;title\nhidden${end}one\ntwo`,
        plain: 'before\none\ntwo',
        linked: false,
      },
    ]),
  ];
  for (const sample of cases) {
    const streams = Array.from({ length: sample.text.length + 1 }, (_, cut) => [
      sample.text.slice(0, cut),
      sample.text.slice(cut),
    ]);
    streams.push(sample.text.split(''));
    for (const chunks of streams) {
      let text = '';
      let pending = '';
      let carried: string | undefined;
      const complete: string[] = [];
      let actual = '';
      for (const chunk of chunks) {
        text += chunk;
        const next = linkifyAppend(pending + chunk, '/work', carried);
        complete.push(...next.complete);
        pending = next.pending;
        carried = next.target;
        actual = [...complete, next.tail].join('\n');
        assert.equal(
          actual,
          linkify(text, '/work'),
          JSON.stringify({ text, chunk }),
        );
      }
      assert.equal(stripAnsi(actual), sample.plain);
      assert.equal(actual.includes(`\u001b]8;;${target}\u0007`), sample.linked);
      if (sample.linked) {
        for (const word of ['one', 'two'])
          assert.ok(
            actual.includes(
              `\u001b]8;;${target}\u0007\u001b[4m${word}\u001b[24m\u001b]8;;\u0007`,
            ),
          );
      }
    }
  }
});
