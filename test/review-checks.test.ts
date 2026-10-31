import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'vitest';
import { checkTargets } from '../src/core/review-checks.js';
import { scratch } from './fixtures/scratch.js';

const execute = promisify(execFile);

/** the failures for `plan.md`, or `target`, among the given files, as `line: message` rows. */
async function check(
  files: Record<string, string>,
  target = 'plan.md',
): Promise<string[]> {
  const root = await scratch('witch-review-checks-');
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return (await checkTargets(root, [target])).map(
    ({ line, message }) => `${line}: ${message}`,
  );
}

const a = 'function a() {\n  b();\n  c();\n}\n';

test('link to a missing heading fails', async () => {
  assert.deepEqual(
    await check({
      'plan.md': '# Plan\n\nsee [rules](rules.md#missing-heading)\n',
      'rules.md': '# Witch commands and compaction\n',
    }),
    ['3: no heading in rules.md has the anchor #missing-heading'],
  );
});

test('link to an existing heading passes', async () => {
  assert.deepEqual(
    await check({
      'plan.md': 'see [rules](rules.md#witch-commands-and-compaction)\n',
      'rules.md': '# Witch commands and compaction\n',
    }),
    [],
  );
});

test("a heading's slug keeps underscores and drops markup", async () => {
  assert.deepEqual(
    await check({
      'plan.md':
        '[a](#base_path_pattern) [b](#route-now)\n\n# BASE_PATH_PATTERN\n\n## `route()` _now_\n',
    }),
    [],
  );
});

test('a repeated heading gets a numbered slug', async () => {
  assert.deepEqual(
    await check({
      'plan.md': '[a](#setup-1) [b](#setup-2)\n\n# Setup\n\n# Setup\n',
    }),
    ['1: no heading in plan.md has the anchor #setup-2'],
  );
});

test('a setext heading has a slug', async () => {
  assert.deepEqual(
    await check({ 'plan.md': '[a](#first-part)\n\nFirst part\n==========\n' }),
    [],
  );
});

test('a heading inside fenced code is not an anchor', async () => {
  assert.deepEqual(
    await check({ 'plan.md': '[a](#hidden)\n\n```\n# Hidden\n```\n' }),
    ['1: no heading in plan.md has the anchor #hidden'],
  );
});

test('a link shown in fenced code or an inline code span is not checked', async () => {
  assert.deepEqual(
    await check({
      'plan.md': '```\n[a](#nowhere)\n```\n\nuse `[a](missing.md)` here\n',
    }),
    [],
  );
});

test('a link inside an HTML comment is not checked, and one beside it is', async () => {
  assert.deepEqual(
    await check({
      'plan.md':
        'a <!-- [b](gone.md) --> c\nd <!-- [e](gone.md)\n[f](gone.md) -->\n<!-- g --> [h](missing.md)\n',
    }),
    ['4: link target missing.md does not exist'],
  );
});

test('a target that is not markdown gets no checks', async () => {
  assert.deepEqual(
    await check({ 'plan.ts': '// a — PR, see [b](missing.md)\n' }, 'plan.ts'),
    [],
  );
});

test("a relative link resolves from the target's directory", async () => {
  assert.deepEqual(
    await check(
      {
        'docs/plan.md': 'see [setup](../README.md#setup)\n',
        'README.md': '# Setup\n',
      },
      'docs/plan.md',
    ),
    [],
  );
});

test('a link title and an encoded space are handled', async () => {
  assert.deepEqual(
    await check({
      'plan.md': 'see [t](my%20file.md "x")\n',
      'my file.md': 'text\n',
    }),
    [],
  );
});

test('a leading slash resolves from the repository root', async () => {
  const root = await scratch('witch-review-checks-');
  await execute('git', ['-C', root, 'init', '-q']);
  await mkdir(join(root, 'docs'));
  await writeFile(join(root, 'README.md'), '# Setup\n');
  await writeFile(
    join(root, 'docs/plan.md'),
    '[ok](/README.md#setup) [gone](/MISSING.md)\n',
  );
  assert.deepEqual(
    (await checkTargets(join(root, 'docs'), ['plan.md'])).map(
      ({ message }) => message,
    ),
    ['link target ../MISSING.md does not exist'],
  );
});

test('a reversed or zero-start range is not a line range', async () => {
  assert.deepEqual(
    await check({
      'plan.md': '`src/a.ts:3-1` and `src/a.ts:0`\n',
      'src/a.ts': a,
    }),
    [
      '1: src/a.ts:3-1 is not a line range',
      '1: src/a.ts:0 is not a line range',
    ],
  );
});

test('line anchor past the end fails, and so does a citation', async () => {
  assert.deepEqual(
    await check({
      'plan.md': '[a](src/a.ts#L9) and `src/a.ts:99`\n',
      'src/a.ts': a,
    }),
    [
      '1: src/a.ts:9 is past the end of src/a.ts (4 lines)',
      '1: src/a.ts:99 is past the end of src/a.ts (4 lines)',
    ],
  );
});

/** a repository with `origin` at `remote` and one commit of `files`; returns its root and the commit. */
async function committed(
  remote: string,
  files: Record<string, string>,
): Promise<{ root: string; commit: string }> {
  const root = await scratch('witch-review-checks-');
  const git = (...args: string[]) =>
    execute('git', [
      '-C',
      root,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      ...args,
    ]);
  await git('init', '-q');
  await git('remote', 'add', 'origin', remote);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }
  await git('add', '-A');
  await git('commit', '-q', '-m', 'files');
  return { root, commit: (await git('rev-parse', 'HEAD')).stdout.trim() };
}

test('a blob link to a missing path fails and an unreadable revision is skipped', async () => {
  const { root, commit } = await committed('git@github.com:owner/repo.git', {
    'x.ts': 'one\n',
  });
  await writeFile(
    join(root, 'plan.md'),
    `[a](https://github.com/owner/repo/blob/${commit}/gone.ts#L1)\n[b](https://github.com/owner/repo/blob/0000000/x.ts#L1)\n[c](https://github.com/other/repo/blob/${commit}/gone.ts)\n`,
  );
  assert.deepEqual(
    (await checkTargets(root, ['plan.md'])).map(
      ({ line, message }) => `${line}: ${message}`,
    ),
    ['1: link target gone.ts does not exist'],
  );
});

test('a blob revision that looks like an option reads nothing and writes nothing', async () => {
  const root = await scratch('witch-review-checks-');
  await execute('git', ['-C', root, 'init', '-q']);
  await execute('git', [
    '-C',
    root,
    'remote',
    'add',
    'origin',
    'https://github.com/owner/repo',
  ]);
  await writeFile(
    join(root, 'plan.md'),
    '[a](https://github.com/owner/repo/blob/--output=written/x.ts)\n',
  );
  assert.deepEqual(await checkTargets(root, ['plan.md']), []);
  await assert.rejects(readFile(join(root, 'written:x.ts')), {
    code: 'ENOENT',
  });
});

test('blob link to this repository reads the cited revision', async () => {
  const { root, commit } = await committed(
    'https://github.com/Owner/Repo.git',
    {
      'src/x.ts': 'one\nclose();\n',
    },
  );
  await writeFile(join(root, 'src/x.ts'), 'changed\n');
  await writeFile(
    join(root, 'plan.md'),
    `[\`close()\`](https://github.com/owner/repo/blob/${commit}/src/x.ts#L2)\n`,
  );
  assert.deepEqual(await checkTargets(root, ['plan.md']), []);
});

test('range that stops inside its block fails', async () => {
  assert.deepEqual(
    await check({
      'plan.md': '`src/a.ts:1-3` and `src/a.ts:1-4`\n',
      'src/a.ts': a,
    }),
    ['1: range ends at line 3, but a block it opens closes at line 4'],
  );
});

test('a nested range names the outer close', async () => {
  assert.deepEqual(
    await check({
      'plan.md': '`src/n.ts:1-3`\n',
      'src/n.ts': 'function a() {\n  if (x) {\n    y;\n  }\n}\n',
    }),
    ['1: range ends at line 3, but a block it opens closes at line 5'],
  );
});

test("a wrapped signature closes at the function's end", async () => {
  assert.deepEqual(
    await check({
      'plan.md': '`src/b.ts:1-6` `src/b.ts:1-3`\n',
      'src/b.ts': 'export function b({\n  x,\n}: B) {\n  y;\n  z;\n}\n',
    }),
    ['1: range ends at line 3, but a block it opens closes at line 6'],
  );
});

test('a range over two sibling functions passes', async () => {
  assert.deepEqual(
    await check({
      'plan.md': '`src/a.ts:1-8`\n',
      'src/a.ts': a + a,
    }),
    [],
  );
});

test('a range ending on an open else fails', async () => {
  assert.deepEqual(
    await check({
      'plan.md': '`src/e.ts:3-4`\n',
      'src/e.ts':
        'function e() {\n  if (x) {\n    y;\n  } else {\n    z;\n  }\n}\n',
    }),
    ['1: range ends at line 4, but a block it opens closes at line 6'],
  );
});

test('a range starting inside a JSDoc comment lexes from line 1', async () => {
  assert.deepEqual(
    await check({
      'plan.md': '`src/d.ts:2-5`\n',
      'src/d.ts': '/**\n * opens ( here\n */\nfunction d() {\n}\n',
    }),
    [],
  );
});

test("comments and escapes don't count", async () => {
  assert.deepEqual(
    await check({
      'plan.md': '`src/c.ts:1-6`\n',
      'src/c.ts':
        "function c() { // (\n  const s = 'it\\'s {';\n  const t = `a\n  { b`;\n  return s;\n}\n",
    }),
    [],
  );
});

test("a URL in a string doesn't hide a closer", async () => {
  assert.deepEqual(
    await check({
      'plan.md': '`src/f.ts:1-2`\n',
      'src/f.ts': "fetch('http://x', {\n});\n",
    }),
    [],
  );
});

test('a JSX closing tag is not a regex', async () => {
  assert.deepEqual(
    await check({
      'plan.md': '`src/j.tsx:1-3`\n',
      'src/j.tsx':
        'const j = (\n  <Box>{x && <Text>y</Text>}{z.map((r) => <Row key={r} />)}</Box>\n);\n',
    }),
    [],
  );
});

test("a regex literal's quotes and brackets don't count", async () => {
  const source = (
    await readFile(
      new URL('../src/agents/tool-title.ts', import.meta.url),
      'utf8',
    )
  )
    .split('\n')
    .slice(65, 80)
    .join('\n');
  assert.deepEqual(
    await check({
      'plan.md': '`src/r.ts:1-15`\n',
      'src/r.ts': `${source}\n`,
    }),
    [],
  );
});

test('an arrow before a regex starts the regex', async () => {
  assert.deepEqual(
    await check({
      'plan.md': '`src/g.ts:1-3`\n',
      'src/g.ts': 'const g = [\n  (x) => /[\'"]/.test(x),\n];\n',
    }),
    [],
  );
});

test('a link range is checked like a citation', async () => {
  assert.deepEqual(
    await check({ 'plan.md': '[t](src/a.ts#L1-L3)\n', 'src/a.ts': a }),
    ['1: range ends at line 3, but a block it opens closes at line 4'],
  );
});

test('a citation path that does not exist is skipped', async () => {
  assert.deepEqual(
    await check({ 'plan.md': 'at `localhost:3000` from `10:00-11:00`\n' }),
    [],
  );
});

test('a cited file that cannot be read stops the checks', async () => {
  const root = await scratch('witch-review-checks-');
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'plan.md'), '`close()` at `src/x.ts:2`\n');
  await writeFile(join(root, 'src/x.ts'), 'one\nclosed();\n');
  await chmod(join(root, 'src/x.ts'), 0o000);
  await assert.rejects(checkTargets(root, ['plan.md']), { code: 'EACCES' });
});

test('identifier missing from its cited line fails', async () => {
  assert.deepEqual(
    await check({
      'plan.md': '`close()` at `src/x.ts:2`\n',
      'src/x.ts': 'one\nclosed();\n',
    }),
    ['1: `close()` does not appear at src/x.ts:2'],
  );
});

test('identifier on its cited line passes', async () => {
  assert.deepEqual(
    await check({
      'plan.md': '`Session.close()` in `src/x.ts:2`\n',
      'src/x.ts': 'one\nthis.close();\n',
    }),
    [],
  );
});

test('a parenthesized citation checks its identifier', async () => {
  assert.deepEqual(
    await check({
      'plan.md': '`close` (`src/x.ts:2`)\n`close` (`src/y.ts:2`)\n',
      'src/x.ts': 'one\nclosed();\n',
      'src/y.ts': 'one\nclose();\n',
    }),
    ['1: `close` does not appear at src/x.ts:2'],
  );
});

test('a link to an identifier is checked', async () => {
  assert.deepEqual(
    await check({
      'plan.md': '[`close()`](src/x.ts#L2)\n',
      'src/x.ts': 'one\ntwo\n',
    }),
    ['1: `close()` does not appear at src/x.ts:2'],
  );
});

test('plain link text is not an identifier', async () => {
  assert.deepEqual(
    await check({
      'plan.md': '[here](src/x.ts#L2)\n',
      'src/x.ts': 'one\ntwo\n',
    }),
    [],
  );
});

test('writing rules flag an em dash, uppercase PR, PRs, CI and AI, and a banned phrase', async () => {
  assert.deepEqual(
    await check({
      'plan.md':
        'one — two\nopen a PR\nthe PRs\nthe CI run\nan AI tell\nit’s worth noting that\n',
    }),
    [
      '1: em dash in prose',
      '2: uppercase PR in prose',
      '3: uppercase PRs in prose',
      '4: uppercase CI in prose',
      '5: uppercase AI in prose',
      `6: banned phrase "it's worth noting that"`,
    ],
  );
});

test('a nested list item is prose', async () => {
  assert.deepEqual(await check({ 'plan.md': '- a\n    - uses — here\n' }), [
    '2: em dash in prose',
  ]);
});

test('banned phrases match whole words', async () => {
  assert.deepEqual(await check({ 'plan.md': 'unhappy today\n' }), []);
});

test('writing checks skip code, link targets, URLs and quotes', async () => {
  assert.deepEqual(
    await check({
      'plan.md': [
        '```',
        '— PR',
        '```',
        'inline `PR`',
        '[t](https://example.com/AI)',
        '<https://example.com/CI>',
        '> PR — ok',
        '<!-- — -->',
        '<!--',
        '— PR',
        '-->',
        '',
      ].join('\n'),
    }),
    [],
  );
});

test('an indented fence under a list item is code', async () => {
  assert.deepEqual(
    await check({ 'plan.md': '- a\n  ```\n  — here\n  ```\n' }),
    [],
  );
});

test('front matter is not prose', async () => {
  assert.deepEqual(
    await check({ 'plan.md': '---\ntitle: a — b\n---\n\nx\n\n---\n— here\n' }),
    ['8: em dash in prose'],
  );
});
