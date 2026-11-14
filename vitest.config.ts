import { availableParallelism } from 'node:os';

import { fileURLToPath } from 'node:url';

import { transformSync } from '@babel/core';

import { configDefaults, defineConfig } from 'vitest/config';

const ui = fileURLToPath(new URL('./src/ui/', import.meta.url));

const configFile = fileURLToPath(new URL('./babel.config.js', import.meta.url));

// keep above the slowest case, so a hang fails naming its test instead of running to ci's job limit
const timeout = 60_000;

const workers = Math.min(8, availableParallelism());

export default defineConfig({
  plugins: [
    {
      name: 'witch-ui-compiler',
      enforce: 'pre',
      transform(source, id) {
        if (!id.startsWith(ui) || !/\.tsx?$/.test(id)) return;

        const { code, map } = transformSync(source, {
          filename: id,
          configFile,
          sourceMaps: true,
        })!;

        return { code: code!, map };
      },
    },
  ],
  test: {
    include: ['test/*.test.ts'],
    forceRerunTriggers: [
      ...configDefaults.forceRerunTriggers,
      '**/test/fixtures/**',
    ],
    maxWorkers: process.platform === 'darwin' ? workers + 4 : workers,
    environment: 'node',
    pool: 'forks',
    isolate: true,
    globals: false,
    sequence: { concurrent: false, shuffle: false },
    retry: 0,
    allowOnly: false,
    passWithNoTests: false,
    testTimeout: timeout,
    hookTimeout: timeout,
    setupFiles: ['./test/fixtures/vitest-setup.ts'],
    globalSetup: ['./test/fixtures/cli-build.ts'],
  },
});
