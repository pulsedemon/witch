import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

const repository = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(process.argv[2] ?? join(repository, 'dist'));

const execute = (module, args) =>
  execFileSync(
    process.execPath,
    [fileURLToPath(import.meta.resolve(module)), ...args],
    {
      cwd: repository,
      stdio: 'inherit',
    },
  );

execute('typescript/bin/tsc', [
  '-p',
  'tsconfig.build.json',
  '--outDir',
  output,
]);

execute('@babel/cli/bin/babel.js', [
  'src/ui',
  '--out-dir',
  join(output, 'ui'),
  '--extensions',
  '.ts,.tsx',
]);

const cli = join(output, 'cli.js');
chmodSync(cli, statSync(cli).mode | 0o111);

writeFileSync(
  join(output, 'native-build.json'),
  JSON.stringify({
    dependencies: createHash('sha256')
      .update(readFileSync(join(repository, 'pnpm-lock.yaml')))
      .digest('hex'),
  }),
);
