import { fileURLToPath } from 'node:url';
import { transformSync } from '@babel/core';
import { defineConfig } from 'vitest/config';
import { testWorkers, vitestFiles } from './scripts/test-suite.js';

const ui = fileURLToPath(new URL('./src/ui/', import.meta.url));
const configFile = fileURLToPath(new URL('./babel.config.js', import.meta.url));

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
    include: [...vitestFiles],
    maxWorkers: testWorkers,
    environment: 'node',
    pool: 'forks',
    isolate: true,
    globals: false,
    sequence: { concurrent: false, shuffle: false },
    retry: 0,
    allowOnly: false,
    passWithNoTests: false,
    testTimeout: 0,
    hookTimeout: 0,
    setupFiles: ['./test/fixtures/vitest-setup.ts'],
  },
});
