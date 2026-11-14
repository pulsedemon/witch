import { execFileSync } from 'node:child_process';

import { symlink } from 'node:fs/promises';

import { delimiter, join } from 'node:path';

import { afterAll, beforeEach, vi } from 'vitest';

import { cleanScratch, scratch } from './scratch.js';

// each PATH directory before git's costs every git spawn a failed execve
const git = await scratch('witch-git-');

await symlink(
  execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim(),
  join(git, 'git'),
);

process.env.PATH = `${git}${delimiter}${process.env.PATH}`;

beforeEach((context) => {
  context.onTestFinished(() => {
    vi.restoreAllMocks();

    vi.useRealTimers();
  });
});

afterAll(cleanScratch);
