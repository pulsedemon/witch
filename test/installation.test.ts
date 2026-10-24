import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  lstat,
  mkdir,
  readFile,
  rename,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'vitest';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { scratch } from './fixtures/scratch.js';

const execute = promisify(execFile);
const installer = fileURLToPath(
  new URL('../scripts/install.ts', import.meta.url),
);
const source =
  '#!/usr/bin/env node\nconsole.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),sentinel:process.env.WITCH_INSTALL_TEST}));\n';

async function fixture() {
  const root = await scratch('witch-install-');
  const checkout = join(root, "owner's old checkout");
  const entry = join(checkout, 'dist', 'cli.js');
  const launcher = join(root, "owner's bin", 'witch');
  await mkdir(dirname(entry), { recursive: true });
  await mkdir(dirname(launcher));
  await writeFile(entry, source, { mode: 0o755 });
  const install = (cwd = checkout) =>
    execute(
      process.execPath,
      ['--import', import.meta.resolve('tsx'), installer, launcher],
      { cwd },
    );
  return { root, checkout, entry, launcher, install };
}

test('launcher preserves arguments and diagnoses a moved checkout', async () => {
  const { root, checkout, entry, launcher, install } = await fixture();
  await install();
  const cwd = join(root, 'caller');
  await mkdir(cwd);
  const run = () =>
    execute(launcher, ['two words', "one's", '--flag'], {
      cwd,
      env: { ...process.env, WITCH_INSTALL_TEST: 'kept-42' },
    });
  const expected = {
    args: ['two words', "one's", '--flag'],
    cwd,
    sentinel: 'kept-42',
  };
  assert.deepEqual(JSON.parse((await run()).stdout), expected);
  const moved = join(root, 'new checkout');
  await rename(checkout, moved);
  await assert.rejects(run(), (error: unknown) => {
    const failure = error as Error & { code: number; stderr: string };
    assert.equal(failure.code, 1);
    assert.ok(failure.stderr.includes(entry));
    assert.match(failure.stderr, /pnpm build.*pnpm install:cli/);
    return true;
  });
  await install(moved);
  assert.deepEqual(JSON.parse((await run()).stdout), expected);
});

test('installing over the legacy symlink leaves its target unchanged', async () => {
  const { entry, launcher, install } = await fixture();
  await symlink(entry, launcher);
  await install();
  assert.equal(await readFile(entry, 'utf8'), source);
  assert.ok((await lstat(launcher)).isFile());
  assert.equal((await execute(launcher, [])).stderr, '');
});

test('installing refuses an unrelated regular file', async () => {
  const { launcher, install } = await fixture();
  await writeFile(launcher, 'kept unrelated file');
  await assert.rejects(install(), /Refusing to replace/);
  assert.equal(await readFile(launcher, 'utf8'), 'kept unrelated file');
});
