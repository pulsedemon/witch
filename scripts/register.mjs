import 'tsx';

import { registerHooks } from 'node:module';

import { fileURLToPath, URL } from 'node:url';

import { transformFileSync } from '@babel/core';

const ui = new URL('../src/ui/', import.meta.url).href;

const configFile = fileURLToPath(
  new URL('../babel.config.js', import.meta.url),
);

registerHooks({
  load(url, context, nextLoad) {
    if (!url.startsWith(ui) || !/\.tsx?$/.test(url))
      return nextLoad(url, context);

    const { code } = transformFileSync(fileURLToPath(url), {
      configFile,
      sourceMaps: 'inline',
    });

    return { format: 'module', source: code, shortCircuit: true };
  },
});
