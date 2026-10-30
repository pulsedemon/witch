import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, appendFile, mkdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, vi } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import {
  RepositoryWatch,
  parsePullRequest,
  parseStatus,
} from '../src/core/repository.js';
import type { Run } from '../src/core/repository.js';
import { scratch } from './fixtures/scratch.js';
import { until } from './fixtures/within.js';

const execute = promisify(execFile);

test("Git's status counts staged, modified and untracked entries, and the branch's distance from its upstream", async () => {
  const root = await scratch('witch-repository-');
  const git = (cwd: string, ...args: string[]) =>
    execute('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
      cwd,
    });
  const remote = join(root, 'remote.git');
  const work = join(root, 'work');
  await git(root, 'init', '--bare', '-b', 'main', remote);
  await git(root, 'clone', remote, work);
  await writeFile(join(work, 'a.txt'), 'a\n');
  await writeFile(join(work, 'b.txt'), 'b\n');
  await git(work, 'add', '.');
  await git(work, 'commit', '-m', 'first');
  await git(work, 'push', '-u', 'origin', 'HEAD:main');
  await git(work, 'commit', '--allow-empty', '-m', 'ahead');
  await writeFile(join(work, 'a.txt'), 'changed\n');
  await writeFile(join(work, 'c.txt'), 'c\n');
  await git(work, 'add', 'c.txt');
  await writeFile(join(work, 'b.txt'), 'staged\n');
  await git(work, 'add', 'b.txt');
  await writeFile(join(work, 'b.txt'), 'and modified\n');
  await mkdir(join(work, 'new'));
  await writeFile(join(work, 'new', 'one.txt'), '1');
  await writeFile(join(work, 'new', 'two.txt'), '2');
  const { stdout } = await git(work, 'status', '--porcelain=v2', '--branch');
  // b.txt is staged and modified; the new directory is one entry
  assert.deepEqual(parseStatus(stdout), {
    branch: 'main',
    ahead: 1,
    behind: 0,
    staged: 2,
    modified: 2,
    conflicts: 0,
    untracked: 1,
  });
});

test("the watch's status read never runs the repository's fsmonitor command", async () => {
  const root = await scratch('witch-repository-');
  const work = join(root, 'work');
  const marker = join(root, 'ran');
  const monitor = join(root, 'monitor.sh');
  await execute('git', ['init', '--quiet', '-b', 'main', work]);
  await writeFile(monitor, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  await execute('git', ['config', 'core.fsmonitor', monitor], { cwd: work });
  const watch = new RepositoryWatch(work, async (command, args, options) => {
    if (command === 'gh') throw new Error('no pull requests found');
    return execute(command, args, options);
  });
  try {
    await until('status read', () => watch.snapshot?.branch === 'main');
    await assert.rejects(access(marker), { code: 'ENOENT' });
  } finally {
    watch.close();
  }
});

test.each([true, false])(
  'a partial clone leaves unavailable status out without SSH and keeps rename counts (no-fetch support: %s)',
  async (noFetchSupport) => {
    const root = await scratch('witch-repository-');
    const source = join(root, 'source');
    const work = join(root, 'work');
    const marker = join(root, 'ran');
    const ssh = join(root, 'ssh.sh');
    const contents = 'unchanged\n'.repeat(20);
    const git = (cwd: string, ...args: string[]) =>
      execute('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
        cwd,
      });
    await git(root, 'init', '--quiet', '-b', 'main', source);
    await writeFile(join(source, 'a'), contents);
    await git(source, 'add', 'a');
    await git(source, 'commit', '--quiet', '-m', 'source');
    await git(source, 'config', 'uploadpack.allowFilter', 'true');
    await git(
      root,
      'clone',
      '--quiet',
      '--filter=blob:none',
      '--no-checkout',
      pathToFileURL(source).href,
      work,
    );
    await git(work, 'read-tree', 'HEAD');
    await git(work, 'rm', '--cached', 'a');
    await writeFile(join(work, 'b'), `${contents}changed\n`);
    await git(work, 'add', 'b');
    const { stdout: objects } = await git(
      work,
      'rev-list',
      '--objects',
      '--all',
      '--missing=print',
    );
    assert.match(objects, /^\?[0-9a-f]+$/m);
    await writeFile(ssh, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, {
      mode: 0o755,
    });
    await git(
      work,
      'config',
      'remote.origin.url',
      'ssh://example.invalid/source',
    );
    await git(work, 'config', 'core.sshCommand', ssh);
    await git(work, 'config', 'protocol.ssh.allow', 'always');
    let reads = 0;
    const watch = new RepositoryWatch(
      work,
      async (command, args, options) => {
        if (command === 'gh') throw new Error('no pull requests found');
        try {
          return await execute(command, args, {
            ...options,
            env: {
              ...process.env,
              ...options.env,
              // unpatched Git 2.43 ignores the no-fetch setting
              ...(!noFetchSupport && { GIT_NO_LAZY_FETCH: '0' }),
            },
          });
        } finally {
          if (args.includes('status')) reads++;
        }
      },
      undefined,
      { interval: 50 },
    );
    try {
      await until('missing-blob status read', () => reads > 0);
      await assert.rejects(access(marker), { code: 'ENOENT' });
      const unavailable = watch.snapshot;
      assert.equal(unavailable, undefined);
      await git(work, 'hash-object', '-w', join(source, 'a'));
      const later = new Date(Date.now() + 60_000);
      await utimes(join(work, 'b'), later, later);
      await until('rename status', () => watch.snapshot?.staged === 1);
      assert.equal(watch.snapshot?.branch, 'main');
      assert.equal(watch.snapshot?.modified, 0);
      await assert.rejects(access(marker), { code: 'ENOENT' });
    } finally {
      watch.close();
    }
  },
);

test("the watch's status read runs no filter driver from the repository's config, and keeps the user's own config", async () => {
  const root = await scratch('witch-repository-');
  const work = join(root, 'work');
  const marker = join(root, 'ran');
  const kept = join(root, 'kept');
  const filter = join(root, 'filter.sh');
  const global = join(root, 'global');
  const git = (...args: string[]) =>
    execute('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
      cwd: work,
    });
  await execute('git', ['init', '--quiet', '-b', 'main', work]);
  for (const name of ['a', 'b', 'c', 'e'])
    await writeFile(join(work, name), `${name}\n`);
  await git('add', 'a', 'b', 'c', 'e');
  await git('commit', '--quiet', '-m', 'first');
  await writeFile(join(work, 'd'), 'd\n');
  await writeFile(filter, `#!/bin/sh\ntouch '${marker}'\ncat\n`, {
    mode: 0o755,
  });
  // a `;` outside quotes starts a config comment
  await writeFile(global, `[filter "g"]\n\tclean = "touch '${kept}'; cat"\n`);
  // `-c` would split `x=y`, a `(.+)` match drops the empty name, and `.` without the `s` flag stops at U+2028
  await git('config', 'filter.x=y.clean', filter);
  await git('config', 'filter.x=y.required', 'true');
  await git('config', 'filter..clean', filter);
  await git('config', 'filter.p\u2028q.process', filter);
  await mkdir(join(work, '.git', 'info'), { recursive: true });
  await writeFile(
    join(work, '.git', 'info', 'attributes'),
    'a filter=x=y\nb filter=\nc filter=p\u2028q\ne filter=g\n',
  );
  const later = new Date(Date.now() + 60_000);
  for (const name of ['a', 'b', 'c', 'e'])
    await utimes(join(work, name), later, later);
  const inherited: Record<string, string> = {
    GIT_CONFIG_GLOBAL: global,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'status.showUntrackedFiles',
    GIT_CONFIG_VALUE_0: 'no',
  };
  const earlier = Object.fromEntries(
    Object.keys(inherited).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, inherited);
  const watch = new RepositoryWatch(work, async (command, args, options) => {
    if (command === 'gh') throw new Error('no pull requests found');
    return execute(command, args, options);
  });
  try {
    await until('status read', () => watch.snapshot?.branch === 'main');
    await assert.rejects(access(marker), { code: 'ENOENT' });
    await access(kept);
    assert.equal(watch.snapshot?.untracked, 0);
  } finally {
    watch.close();
    for (const [key, value] of Object.entries(earlier))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
});

test("a submodule's own filter driver never runs, and changes inside its work tree don't count", async () => {
  const root = await scratch('witch-repository-');
  const sub = join(root, 'sub');
  const top = join(root, 'top');
  const marker = join(root, 'ran');
  const filter = join(root, 'filter.sh');
  const git = (cwd: string, ...args: string[]) =>
    execute(
      'git',
      [
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@t',
        '-c',
        'protocol.file.allow=always',
        ...args,
      ],
      { cwd },
    );
  await execute('git', ['init', '--quiet', '-b', 'main', sub]);
  await writeFile(join(sub, 's'), 's\n');
  await writeFile(join(sub, 't'), 't\n');
  await git(sub, 'add', 's', 't');
  await git(sub, 'commit', '--quiet', '-m', 'first');
  await execute('git', ['init', '--quiet', '-b', 'main', top]);
  await git(top, 'submodule', '--quiet', 'add', sub, 'sub');
  await git(top, 'commit', '--quiet', '-m', 'sub');
  await writeFile(filter, `#!/bin/sh\ntouch '${marker}'\ncat\n`, {
    mode: 0o755,
  });
  const modules = join(top, '.git', 'modules', 'sub');
  await execute('git', ['config', 'filter.z.clean', filter], {
    cwd: join(top, 'sub'),
  });
  await mkdir(join(modules, 'info'), { recursive: true });
  await writeFile(join(modules, 'info', 'attributes'), 's filter=z\n');
  const later = new Date(Date.now() + 60_000);
  await utimes(join(top, 'sub', 's'), later, later);
  await writeFile(join(top, 'sub', 't'), 'changed\n');
  const watch = new RepositoryWatch(
    top,
    async (command, args, options) => {
      if (command === 'gh') throw new Error('no pull requests found');
      return execute(command, args, options);
    },
    undefined,
    { interval: 50 },
  );
  try {
    await until('status read', () => watch.snapshot?.branch === 'main');
    await assert.rejects(access(marker), { code: 'ENOENT' });
    assert.equal(watch.snapshot?.modified, 0);
    // a submodule at another commit still counts, and watchMerges relies on it
    await git(
      join(top, 'sub'),
      'commit',
      '--quiet',
      '--allow-empty',
      '-m',
      'moved',
    );
    await until('moved submodule', () => watch.snapshot?.modified === 1);
  } finally {
    watch.close();
  }
});

test("a filter driver whose name isn't valid UTF-8 leaves Git out without running status", async () => {
  const root = await scratch('witch-repository-');
  const work = join(root, 'work');
  const marker = join(root, 'ran');
  const filter = join(root, 'filter.sh');
  await execute('git', ['init', '--quiet', '-b', 'main', work]);
  await writeFile(join(work, 'a'), 'a\n');
  await execute('git', ['add', 'a'], { cwd: work });
  await execute(
    'git',
    [
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      'commit',
      '--quiet',
      '-m',
      'a',
    ],
    { cwd: work },
  );
  await writeFile(filter, `#!/bin/sh\ntouch '${marker}'\ncat\n`, {
    mode: 0o755,
  });
  // the default UTF-8 encoding would write `\xff` as C3 BF, which is valid UTF-8
  await appendFile(
    join(work, '.git', 'config'),
    Buffer.from(`[filter "b\xffd"]\n\tclean = ${filter}\n`, 'latin1'),
  );
  await mkdir(join(work, '.git', 'info'), { recursive: true });
  await writeFile(
    join(work, '.git', 'info', 'attributes'),
    Buffer.from('a filter=b\xffd\n', 'latin1'),
  );
  const later = new Date(Date.now() + 60_000);
  await utimes(join(work, 'a'), later, later);
  let listings = 0;
  let statuses = 0;
  const watch = new RepositoryWatch(
    work,
    async (command, args, options) => {
      if (command === 'gh') throw new Error('no pull requests found');
      if (args.includes('config')) listings++;
      if (args.includes('status')) statuses++;
      return execute(command, args, options);
    },
    undefined,
    { interval: 50 },
  );
  try {
    // reads don't overlap, so a second listing means the first read has finished
    await until('second listing', () => listings >= 2);
    assert.equal(statuses, 0);
    assert.equal(watch.snapshot, undefined);
  } finally {
    watch.close();
  }
});

test('a detached head reads as HEAD, and branch.ab and unmerged entries count', () => {
  assert.deepEqual(
    parseStatus(
      [
        '# branch.oid 0123',
        '# branch.head (detached)',
        '# branch.ab +0 -3',
        'u UU N... 100644 100644 100644 100644 a b c conflicted.txt',
        '',
      ].join('\n'),
    ),
    {
      branch: 'HEAD',
      ahead: 0,
      behind: 3,
      staged: 0,
      modified: 0,
      conflicts: 1,
      untracked: 0,
    },
  );
});

const view = (fields: object) =>
  JSON.stringify({
    number: 4,
    url: 'https://x.test/4',
    headRefName: 'feat/x',
    headRefOid: 'a1b2c3',
    baseRefName: 'develop',
    mergeable: 'MERGEABLE',
    ...fields,
  });

test("a pull request's checks fail on a failed run or status, stay pending while any runs or none exist, and pass otherwise, and only an open one carries its mergeability", () => {
  const checks = (rollup: object[]) =>
    parsePullRequest(view({ state: 'OPEN', statusCheckRollup: rollup })).checks;
  const done = (conclusion: string) => ({
    __typename: 'CheckRun',
    status: 'COMPLETED',
    conclusion,
  });
  assert.equal(checks([]), 'pending');
  assert.equal(checks([done('SUCCESS'), done('SKIPPED')]), 'passing');
  assert.equal(
    checks([
      done('SUCCESS'),
      { __typename: 'CheckRun', status: 'IN_PROGRESS' },
    ]),
    'pending',
  );
  assert.equal(
    checks([
      done('FAILURE'),
      { __typename: 'CheckRun', status: 'QUEUED', conclusion: null },
    ]),
    'failing',
  );
  assert.equal(
    checks([{ __typename: 'StatusContext', state: 'ERROR' }]),
    'failing',
  );
  assert.equal(
    checks([{ __typename: 'StatusContext', state: 'EXPECTED' }]),
    'pending',
  );
  assert.equal(
    parsePullRequest(
      view({ state: 'OPEN', statusCheckRollup: [], mergeable: 'CONFLICTING' }),
    ).mergeable,
    'CONFLICTING',
  );
  assert.deepEqual(
    parsePullRequest(view({ state: 'MERGED', statusCheckRollup: [] })),
    {
      number: 4,
      url: 'https://x.test/4',
      state: 'MERGED',
      branch: 'feat/x',
      commit: 'a1b2c3',
      base: 'develop',
    },
  );
});

test('the watch reads the pull request once per branch, again when the branch changes or 90 seconds pass, and publishes only changes', async () => {
  vi.useFakeTimers({
    toFake: ['setInterval', 'clearInterval', 'Date'],
    now: 0,
  });
  let branch = 'main';
  const reads: string[] = [];
  let fields: string | undefined;
  const watch = new RepositoryWatch('/work', async (command, args) => {
    if (command === 'gh') {
      reads.push(branch);
      fields = args.at(-1);
    }
    return {
      stdout:
        command === 'gh'
          ? view({ state: 'OPEN', statusCheckRollup: [] })
          : `# branch.head ${branch}\n`,
    };
  });
  let published = 0;
  watch.subscribe(() => published++);
  try {
    await delay(20);
    assert.equal(watch.snapshot?.pullRequest?.number, 4);
    assert.match(
      fields ?? '',
      /,headRefName,headRefOid,baseRefName,mergeable$/,
    );
    const settled = published;
    vi.advanceTimersByTime(5000);
    await delay(20);
    assert.equal(published, settled);
    branch = 'feat/x';
    vi.advanceTimersByTime(5000);
    await delay(20);
    assert.equal(watch.snapshot?.branch, 'feat/x');
    assert.deepEqual(reads, ['main', 'feat/x']);
    vi.advanceTimersByTime(85_000);
    await delay(20);
    assert.deepEqual(reads, ['main', 'feat/x']);
    vi.advanceTimersByTime(5000);
    await delay(20);
    assert.deepEqual(reads, ['main', 'feat/x', 'feat/x']);
  } finally {
    watch.close();
  }
});

test('a failed git read leaves Git out, and a failed gh read leaves the pull request out until the next read 90 seconds on', async () => {
  vi.useFakeTimers({
    toFake: ['setInterval', 'clearInterval', 'Date'],
    now: 0,
  });
  let repository = false;
  let reads = 0;
  const watch = new RepositoryWatch('/work', async (command) => {
    if (command === 'gh') {
      reads++;
      throw new Error('no pull requests found for branch "main"');
    }
    if (!repository) throw new Error('fatal: not a git repository');
    return { stdout: '# branch.head main\n' };
  });
  try {
    await delay(20);
    assert.equal(watch.snapshot?.branch, undefined);
    repository = true;
    vi.advanceTimersByTime(5000);
    await delay(20);
    assert.equal(watch.snapshot?.branch, 'main');
    assert.equal(watch.snapshot?.pullRequest, undefined);
    assert.equal(reads, 1);
    vi.advanceTimersByTime(85_000);
    await delay(20);
    assert.equal(reads, 1);
    vi.advanceTimersByTime(5000);
    await delay(20);
    assert.equal(reads, 2);
    repository = false;
    vi.advanceTimersByTime(5000);
    await delay(20);
    assert.equal(watch.snapshot?.branch, undefined);
  } finally {
    watch.close();
  }
});

test('a read still running skips the next ticks, and a pull request read for a branch left meanwhile is dropped', async () => {
  vi.useFakeTimers({
    toFake: ['setInterval', 'clearInterval', 'Date'],
    now: 0,
  });
  let branch = 'main';
  const git: PromiseWithResolvers<{ stdout: string }>[] = [];
  const gh: PromiseWithResolvers<{ stdout: string }>[] = [];
  const watch = new RepositoryWatch('/work', (command, args) => {
    if (args[0] === 'config') return Promise.resolve({ stdout: '' });
    const read = Promise.withResolvers<{ stdout: string }>();
    (command === 'gh' ? gh : git).push(read);
    return read.promise;
  });
  try {
    vi.advanceTimersByTime(5000);
    vi.advanceTimersByTime(5000);
    await delay(20);
    assert.equal(git.length, 1);
    git[0]!.resolve({ stdout: `# branch.head ${branch}\n` });
    await delay(20);
    assert.equal(watch.snapshot?.branch, 'main');
    assert.equal(gh.length, 1);
    branch = 'feat/x';
    for (let tick = 0; tick < 3; tick++) {
      vi.advanceTimersByTime(5000);
      await delay(20);
      git.at(-1)!.resolve({ stdout: `# branch.head ${branch}\n` });
      await delay(20);
    }
    assert.equal(watch.snapshot?.branch, 'feat/x');
    assert.equal(gh.length, 1);
    gh[0]!.resolve({ stdout: view({ state: 'OPEN', statusCheckRollup: [] }) });
    await delay(20);
    assert.equal(watch.snapshot?.pullRequest, undefined);
  } finally {
    watch.close();
  }
});

/** a watch on `main` whose pull request reads answer with `answer`, recording each tip lookup's arguments. */
function conflictWatch(options: {
  answer: () => object | Error;
  tip?: () => string | Error;
  branch?: () => string;
  project?: () => Promise<string>;
}) {
  const reads = { pr: 0, tips: [] as string[][] };
  const watch = new RepositoryWatch(
    '/work',
    async (command, args) => {
      if (command !== 'gh')
        return { stdout: `# branch.head ${options.branch?.() ?? 'main'}\n` };
      if (args[0] === 'api') {
        reads.tips.push(args);
        const tip = options.tip?.() ?? 'f00';
        if (tip instanceof Error) throw tip;
        return { stdout: `${tip}\n` };
      }
      reads.pr++;
      const answer = options.answer();
      if (answer instanceof Error) throw answer;
      return {
        stdout: view({
          url: 'https://github.com/o/r/pull/4',
          state: 'OPEN',
          statusCheckRollup: [],
          ...answer,
        }),
      };
    },
    options.project,
  );
  return { watch, reads };
}

test("a conflicting read records its base's tip, and only a fresh read that no longer describes that conflict clears it", async () => {
  vi.useFakeTimers({
    toFake: ['setInterval', 'clearInterval', 'Date'],
    now: 0,
  });
  let answer: object | Error = { mergeable: 'CONFLICTING' };
  let tip: string | Error = 'f00';
  const { watch, reads } = conflictWatch({
    answer: () => answer,
    tip: () => tip,
  });
  // a function, so an assertion that it's unset doesn't narrow later reads
  const conflict = () => watch.snapshot?.conflict;
  const read = async (next: object | Error) => {
    answer = next;
    watch.refreshPullRequest();
    vi.advanceTimersByTime(5000);
    await delay(20);
  };
  try {
    await delay(20);
    assert.deepEqual(reads.tips, [
      [
        'api',
        '--hostname',
        'github.com',
        'repos/o/r/commits/develop',
        '--jq',
        '.sha',
      ],
    ]);
    assert.equal(conflict()?.baseTip, 'f00');
    assert.equal(conflict()?.pullRequest.commit, 'a1b2c3');
    await read({ mergeable: 'UNKNOWN' });
    assert.equal(watch.snapshot?.pullRequest?.mergeable, 'UNKNOWN');
    assert.equal(conflict()?.baseTip, 'f00');
    await read(new Error('network'));
    assert.equal(watch.snapshot?.pullRequest, undefined);
    assert.equal(conflict()?.baseTip, 'f00');
    await read({ mergeable: 'UNKNOWN' });
    assert.equal(conflict()?.baseTip, 'f00');
    assert.equal(reads.tips.length, 1);
    await read({ mergeable: 'UNKNOWN', headRefOid: 'd4e5f6' });
    assert.equal(conflict(), undefined);
    tip = new Error('not found');
    await read({ mergeable: 'CONFLICTING' });
    assert.ok(conflict());
    assert.equal(conflict()?.baseTip, undefined);
    await read({ mergeable: 'UNKNOWN', baseRefName: 'main' });
    assert.equal(conflict(), undefined);
    await read({ mergeable: 'CONFLICTING' });
    await read({ mergeable: 'MERGEABLE' });
    assert.equal(conflict(), undefined);
    await read({ mergeable: 'CONFLICTING' });
    await read({ state: 'MERGED' });
    assert.equal(conflict(), undefined);
    assert.equal(reads.tips.length, 4);
  } finally {
    watch.close();
  }
});

test('an uncomputed mergeability is read again after 10 seconds, while a status read in between keeps a conflict', async () => {
  vi.useFakeTimers({
    toFake: ['setInterval', 'clearInterval', 'Date'],
    now: 0,
  });
  let answer: object = { mergeable: 'CONFLICTING' };
  const { watch, reads } = conflictWatch({ answer: () => answer });
  try {
    await delay(20);
    answer = { mergeable: 'UNKNOWN' };
    watch.refreshPullRequest();
    vi.advanceTimersByTime(5000);
    await delay(20);
    assert.equal(reads.pr, 2);
    vi.advanceTimersByTime(5000);
    await delay(20);
    assert.equal(reads.pr, 2);
    assert.ok(watch.snapshot?.conflict);
    vi.advanceTimersByTime(5000);
    await delay(20);
    assert.equal(reads.pr, 3);
  } finally {
    watch.close();
  }
});

test('another local branch leaves a conflict out of the snapshot, and a read for another project leaves it in place', async () => {
  vi.useFakeTimers({
    toFake: ['setInterval', 'clearInterval', 'Date'],
    now: 0,
  });
  let branch = 'main';
  let answer: object | Error = { mergeable: 'CONFLICTING' };
  let project = 'a';
  let asked = 0;
  const { watch } = conflictWatch({
    answer: () => answer,
    branch: () => branch,
    // the second call checks the project hasn't changed while gh ran
    project: async () => (asked++ % 2 ? project : 'a'),
  });
  try {
    await delay(20);
    assert.ok(watch.snapshot?.conflict);
    project = 'b';
    answer = { mergeable: 'MERGEABLE' };
    watch.refreshPullRequest();
    vi.advanceTimersByTime(5000);
    await delay(20);
    assert.ok(watch.snapshot?.conflict);
    project = 'a';
    answer = new Error('no pull requests found');
    branch = 'feat/y';
    vi.advanceTimersByTime(5000);
    await delay(20);
    assert.equal(watch.snapshot?.branch, 'feat/y');
    assert.equal(watch.snapshot?.conflict, undefined);
  } finally {
    watch.close();
  }
});

test('a refresh asked for while a pull request read runs reads again once it ends', async () => {
  vi.useFakeTimers({
    toFake: ['setInterval', 'clearInterval', 'Date'],
    now: 0,
  });
  const gh: PromiseWithResolvers<{ stdout: string }>[] = [];
  const watch = new RepositoryWatch('/work', (command) => {
    if (command !== 'gh')
      return Promise.resolve({ stdout: '# branch.head main\n' });
    const read = Promise.withResolvers<{ stdout: string }>();
    gh.push(read);
    return read.promise;
  });
  try {
    await delay(20);
    assert.equal(gh.length, 1);
    watch.refreshPullRequest();
    vi.advanceTimersByTime(5000);
    await delay(20);
    assert.equal(gh.length, 1);
    gh[0]!.resolve({ stdout: view({ state: 'OPEN', statusCheckRollup: [] }) });
    await delay(20);
    vi.advanceTimersByTime(5000);
    await delay(20);
    assert.equal(gh.length, 2);
  } finally {
    watch.close();
  }
});

test('a detached head reads no pull request', async () => {
  vi.useFakeTimers({
    toFake: ['setInterval', 'clearInterval', 'Date'],
    now: 0,
  });
  const calls: Parameters<Run>[] = [];
  const watch = new RepositoryWatch('/work', async (...args) => {
    calls.push(args);
    return { stdout: '# branch.head (detached)\n' };
  });
  try {
    await delay(20);
    vi.advanceTimersByTime(5000);
    await delay(20);
    assert.equal(watch.snapshot?.branch, 'HEAD');
    assert.equal(calls.length, 4);
    for (const [command, args, { cwd, timeout, env }] of calls) {
      assert.equal(command, 'git');
      assert.equal(cwd, '/work');
      assert.equal(timeout, 10_000);
      assert.deepEqual(
        args,
        args.includes('status')
          ? [
              '-c',
              'core.fsmonitor=false',
              '--no-optional-locks',
              'status',
              '--porcelain=v2',
              '--branch',
              '--ignore-submodules=dirty',
            ]
          : ['config', '-z', '--name-only', '--show-scope', '--list'],
      );
      if (args.includes('status')) {
        assert.equal(env?.GIT_NO_LAZY_FETCH, '1');
        assert.equal(env?.GIT_ALLOW_PROTOCOL, '');
      }
    }
    assert.equal(calls.filter(([, args]) => args.includes('status')).length, 2);
  } finally {
    watch.close();
  }
});

test('a cached pull request keeps its observed project until a fresh scoped read', async () => {
  vi.useFakeTimers({
    toFake: ['setInterval', 'clearInterval', 'Date'],
    now: 0,
  });
  let project = 'project-a';
  const watch = new RepositoryWatch(
    '/work',
    async (command) => ({
      stdout:
        command === 'gh' ? view({ state: 'MERGED' }) : '# branch.head feat/x\n',
    }),
    async () => project,
  );
  try {
    await until(
      'initial scoped observation',
      () => watch.snapshot?.pullRequestProject === 'project-a',
    );
    project = 'project-b';
    vi.advanceTimersByTime(5000);
    await delay(20);
    assert.equal(watch.snapshot?.pullRequestProject, 'project-a');
    vi.advanceTimersByTime(85_000);
    await until(
      'fresh scoped observation',
      () => watch.snapshot?.pullRequestProject === 'project-b',
    );
    assert.equal(watch.snapshot?.pullRequest?.state, 'MERGED');
  } finally {
    watch.close();
  }
});

test('a project change during a pull request read invalidates the observation', async () => {
  let project = 'project-a';
  let scopeReads = 0;
  const watch = new RepositoryWatch(
    '/work',
    async (command) => {
      if (command === 'git') return { stdout: '# branch.head feat/x\n' };
      project = 'project-b';
      return { stdout: view({ state: 'MERGED' }) };
    },
    async () => {
      scopeReads++;
      return project;
    },
  );
  try {
    await until('scope recheck', () => scopeReads === 2);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(watch.snapshot?.pullRequest, undefined);
  } finally {
    watch.close();
  }
});
