import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ESLint } from 'eslint';
import { test } from 'vitest';
import { scratch } from '../fixtures/scratch.js';

test('ESLint enforces PascalCase TSX names at root and nested paths without restricting TS helpers', async () => {
  const root = await scratch('witch-eslint-filenames-');
  const repository = fileURLToPath(new URL('../../', import.meta.url));

  const cases = [
    ['src/passing/Input.tsx', true],
    ['src/nested/HTTPStatus2.tsx', true],
    ['Bootstrap.tsx', true],
    ['src/failing/input.tsx', false],
    ['src/failing/status-line.tsx', false],
    ['invalid-root.tsx', false],
    ['src/helper.ts', true],
  ] as const;

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

  for (const [file] of cases) {
    const target = join(root, file);

    await mkdir(dirname(target), { recursive: true });

    await writeFile(
      target,
      'export function Component() {\n  return null;\n}\n',
    );
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

  assert.deepEqual(
    Object.fromEntries(
      reports.map(({ filePath, messages }) => [
        relative(root, filePath),
        messages.map(({ ruleId, severity }) => ({ ruleId, severity })),
      ]),
    ),
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
