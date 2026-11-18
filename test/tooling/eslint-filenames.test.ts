import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ESLint } from 'eslint';
import { test } from 'vitest';
import { scratch } from '../fixtures/scratch.js';

const component = 'export function Component() {\n  return null;\n}\n';
const hook = 'export function useThing() {\n  return 1;\n}\n';

/** lints `files` under the repository's config in a scratch project; each file's rule ids, by path. */
async function lint(files: Readonly<Record<string, string>>) {
  const root = await scratch('witch-eslint-filenames-');
  const repository = fileURLToPath(new URL('../../', import.meta.url));

  await copyFile(
    join(repository, 'eslint.config.js'),
    join(root, 'eslint.config.js'),
  );

  await symlink(join(repository, 'node_modules'), join(root, 'node_modules'));
  await writeFile(join(root, 'package.json'), '{"type":"module"}');

  await writeFile(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2023',
        module: 'NodeNext',
        jsx: 'react-jsx',
        strict: true,
      },
      include: ['src'],
    }),
  );

  for (const [file, source] of Object.entries(files)) {
    const target = join(root, file);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, source);
  }

  const result = spawnSync(
    process.execPath,
    [
      join(repository, 'node_modules/eslint/bin/eslint.js'),
      '--format',
      'json',
      '.',
    ],
    { cwd: root, encoding: 'utf8' },
  );

  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  const reports = JSON.parse(result.stdout) as ESLint.LintResult[];

  return Object.fromEntries(
    reports.map(({ filePath, messages }) => [
      relative(root, filePath),
      messages.map(({ ruleId, severity }) => ({ ruleId, severity })),
    ]),
  );
}

test('ESLint enforces PascalCase TSX names at root and nested paths without restricting TS helpers', async () => {
  const cases = [
    ['src/passing/Input.tsx', true],
    ['src/nested/HTTPStatus2.tsx', true],
    ['Bootstrap.tsx', true],
    ['src/failing/input.tsx', false],
    ['src/failing/status-line.tsx', false],
    ['invalid-root.tsx', false],
    ['src/helper.ts', true],
  ] as const;

  assert.deepEqual(
    await lint(Object.fromEntries(cases.map(([file]) => [file, component]))),
    {
      'eslint.config.js': [],
      ...Object.fromEntries(
        cases.map(([file, valid]) => [
          file,
          valid ? [] : [{ ruleId: 'witch/pascal-case-tsx', severity: 2 }],
        ]),
      ),
    },
  );
});

test('ESLint names a TS file after the hook that is its only runtime export, and leaves mixed modules and TSX alone', async () => {
  const cases = [
    ['src/useThing.ts', hook, true],
    ['src/thing.ts', hook, false],
    ['src/nested/use-thing.ts', hook, false],
    // a different hook's name is still not this hook's
    ['src/useOther.ts', hook, false],
    ['src/typed.ts', `export type Thing = number;\n\n${hook}`, false],
    [
      'src/listed.ts',
      'function useThing() {\n  return 1;\n}\n\nexport { useThing };\n',
      false,
    ],
    ['src/mixed.ts', `export const limit = 1;\n\n${hook}`, true],
    [
      'src/hooks.ts',
      `${hook}\nexport function useOther() {\n  return 2;\n}\n`,
      true,
    ],
    ['src/Widget.tsx', hook, true],
  ] as const;

  assert.deepEqual(
    await lint(
      Object.fromEntries(cases.map(([file, source]) => [file, source])),
    ),
    {
      'eslint.config.js': [],
      ...Object.fromEntries(
        cases.map(([file, , valid]) => [
          file,
          valid ? [] : [{ ruleId: 'witch/hook-filename', severity: 2 }],
        ]),
      ),
    },
  );
});
