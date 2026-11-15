import { rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestProject } from 'vitest/node';
import { cleanScratch, scratch } from './scratch.js';

declare module 'vitest' {
  export interface ProvidedContext {
    /** the shared CLI build directory for this run. */
    cliBuild: string;
  }
}

const repository = fileURLToPath(new URL('../../', import.meta.url));

/** one CLI build directory per run, shared by every worker. */
export default async function setup(project: TestProject) {
  const root = await scratch('witch-cli-build-');

  await symlink(join(repository, 'node_modules'), join(root, 'node_modules'));

  await symlink(join(repository, 'package.json'), join(root, 'package.json'));

  project.provide('cliBuild', root);

  // a watch rerun must not run the CLI built from the previous run's source
  project.onTestsRerun(() =>
    rm(join(root, 'dist'), { recursive: true, force: true }),
  );

  return cleanScratch;
}
