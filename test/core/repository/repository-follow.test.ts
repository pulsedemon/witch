import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test, vi } from 'vitest';
import { RepositoryWatch } from '../../../src/core/repository/repository.js';
import type { Repository } from '../../../src/core/repository/repository.js';
import type { RegisterCleanup } from '../../fixtures/cleanup.js';
import { view } from '../../fixtures/repository.js';

const url7 = 'https://x.test/7';

/** `gh pr view` output for pull request #7 from `feat/x`, or `number` from `branch`. */
const pr = (
  state: string,
  fields: { number?: number; branch?: string; url?: string } = {},
) => {
  const number = fields.number ?? 7;

  return view({
    number,
    url: fields.url ?? `https://x.test/${number}`,
    headRefName: fields.branch ?? 'feat/x',
    state,
    statusCheckRollup: [],
    ...(state === 'MERGED' ? { mergedAt: '2026-11-16T00:00:00Z' } : {}),
  });
};

/** how `gh pr view` fails when it finds no pull request, an answer like any other. */
const none = (name: string) =>
  Object.assign(new Error('Command failed: gh pr view'), {
    code: 1,
    stderr: `no pull requests found for branch "${name}"\n`,
  });

/** a failure `gh` itself can give, which waits for the next read. */
const unavailable = () =>
  Object.assign(new Error('Command failed: gh pr view\nHTTP 502'), { code: 1 });

const timedOut = () =>
  Object.assign(new Error('Timed out after 30000 ms: Command failed: gh'), {
    killed: true,
    signal: 'SIGTERM',
    code: null,
  });

type Answer = string | Error | Promise<string>;

/**
 * a polling watch over `/work` on `feat/x`, at a faked time of 0. `answer` gets `gh pr view`'s selector, '' for the
 * checked-out branch's own read, and the branch checked out when it ran.
 */
function harness(
  register: RegisterCleanup,
  answer: (selector: string, branch: string) => Answer,
  {
    branch = 'feat/x',
    previous,
    project,
  }: {
    branch?: string;
    /** what `@{-1}` answers, or how asking fails. unset, there is no previous branch. */
    previous?: string | (() => string);
    project?: () => Promise<string>;
  } = {},
) {
  vi.useRealTimers();

  vi.useFakeTimers({
    toFake: ['setInterval', 'clearInterval', 'Date'],
    now: 0,
  });

  const state = { branch, status: true };
  const reads: string[] = [];
  const published: Repository[] = [];

  const watch = new RepositoryWatch(
    '/work',
    async (command, args) => {
      // only a GitHub URL's checks adjustment asks the API, and its answer can't be parsed
      if (command === 'gh' && args[0] === 'api') return { stdout: '{}' };

      if (command === 'gh') {
        const selector = args[2] === '--json' ? '' : args[2]!;
        reads.push(selector);
        const result = await answer(selector, state.branch);

        if (result instanceof Error) throw result;

        return { stdout: result };
      }

      if (args[0] === 'rev-parse') {
        if (previous === undefined)
          throw Object.assign(new Error('fatal: no previous branch'), {
            code: 128,
          });

        return {
          stdout: `${typeof previous === 'function' ? previous() : previous}\n`,
        };
      }

      if (args[0] === 'config') return { stdout: '' };

      if (!state.status)
        throw Object.assign(new Error('fatal: unable to read index'), {
          code: 128,
        });

      return { stdout: `# branch.head ${state.branch}\n` };
    },
    project,
  );

  register(() => watch.close());

  watch.subscribe(() => {
    if (watch.snapshot) published.push(watch.snapshot);
  });

  const step = async () => {
    vi.advanceTimersByTime(5000);
    await delay(20);
  };

  return {
    watch,
    state,
    published,
    step,
    /** one tick at a time, so each round sees the time it ran at. */
    wait: async (ms: number) => {
      for (let passed = 0; passed < ms; passed += 5000) await step();
    },
    /** `gh pr view` reads by name or URL. */
    named: () => reads.filter(Boolean),
    followed: () =>
      watch.snapshot?.followed?.map(
        ({ number, state }) => `#${number} ${state}`,
      ),
  };
}

const settle = () => delay(20);

for (const end of ['unfollowed', 'closed', 'returned'] as const)
  test(`a pull request stays followed after the checkout leaves its branch, is read by URL every 90 seconds, and goes when it closes, the checkout returns or it is unfollowed: ${end}`, async (t) => {
    let read = 'OPEN';

    const { watch, state, published, step, wait, named, followed } = harness(
      t.onTestFinished,
      (selector, branch) =>
        selector === url7
          ? pr(read)
          : selector === '' && branch === 'feat/x'
            ? pr('OPEN')
            : none(selector || branch),
    );

    await settle();
    assert.equal(watch.snapshot?.pullRequest?.number, 7);
    state.branch = 'main';
    await step();

    assert.deepEqual(
      published.find(({ branch }) => branch === 'main')?.followed?.[0]?.url,
      url7,
    );

    assert.deepEqual(named(), []);
    await wait(80_000);
    assert.deepEqual(named(), []);
    await step();
    assert.deepEqual(named(), [url7]);
    assert.deepEqual(followed(), ['#7 OPEN']);

    if (end === 'unfollowed') {
      read = 'MERGED';
      await wait(90_000);
      assert.deepEqual(followed(), ['#7 MERGED']);
      await wait(270_000);
      assert.deepEqual(named(), [url7, url7]);
      assert.deepEqual(followed(), ['#7 MERGED']);
      watch.unfollow(url7);
    } else if (end === 'closed') {
      read = 'CLOSED';
      await wait(90_000);
    } else {
      state.branch = 'feat/x';
      await step();
    }

    assert.equal(watch.snapshot?.followed, undefined);

    assert.ok(
      published
        .filter(({ branch }) => branch === 'main')
        .every(({ pullRequest }) => pullRequest === undefined),
    );
  });

test("a branch left after its pull request merged is followed at once, one left after it closed isn't, and each looks for a newer one by name", async (t) => {
  for (const last of ['MERGED', 'CLOSED']) {
    const { state, published, step, named, followed } = harness(
      t.onTestFinished,
      (selector, branch) =>
        selector === 'feat/x'
          ? pr('OPEN', { number: 8 })
          : selector === '' && branch === 'feat/x'
            ? pr(last)
            : none(selector || branch),
    );

    await settle();
    state.branch = 'main';
    await step();

    assert.deepEqual(
      published
        .find(({ branch }) => branch === 'main')
        ?.followed?.map(({ number }) => number),
      last === 'MERGED' ? [7] : undefined,
    );

    assert.deepEqual(named(), ['feat/x']);

    assert.deepEqual(
      followed(),
      last === 'MERGED' ? ['#8 OPEN', '#7 MERGED'] : ['#8 OPEN'],
    );
  }
});

test('an entry unfollowed while its read runs stays gone', async (t) => {
  let held: PromiseWithResolvers<string> | undefined;

  const { watch, state, step, wait, named } = harness(
    t.onTestFinished,
    (selector, branch) =>
      selector === url7
        ? (held = Promise.withResolvers()).promise
        : selector === '' && branch === 'feat/x'
          ? pr('OPEN')
          : none(selector || branch),
  );

  await settle();
  state.branch = 'main';
  await step();
  await wait(85_000);
  assert.ok(held);
  watch.unfollow(url7);
  assert.equal(watch.snapshot?.followed, undefined);
  held.resolve(pr('OPEN'));
  await settle();
  assert.equal(watch.snapshot?.followed, undefined);
  await wait(90_000);
  assert.equal(watch.snapshot?.followed, undefined);
  assert.deepEqual(named(), [url7]);
});

test("a pull request whose branch's last read failed is followed from the read before it", async (t) => {
  let reads = 0;

  const { state, step, wait, named, followed } = harness(
    t.onTestFinished,
    (selector, branch) =>
      selector === url7
        ? pr('MERGED')
        : selector === '' && branch === 'feat/x'
          ? ++reads === 1
            ? pr('OPEN')
            : unavailable()
          : none(selector || branch),
  );

  await settle();
  await wait(90_000);
  assert.equal(reads, 2);
  state.branch = 'main';
  await step();
  assert.deepEqual(named(), [url7]);
  assert.deepEqual(followed(), ['#7 MERGED']);
});

for (const meanwhile of ['nothing', 'another unfollowed'] as const)
  test(`a branch read that finishes after the checkout left is followed${meanwhile === 'nothing' ? '' : ', though another pull request was unfollowed meanwhile'}`, async (t) => {
    const held = Promise.withResolvers<string>();

    const { watch, state, step, named, followed } = harness(
      t.onTestFinished,
      (selector, branch) =>
        selector === '' && branch === 'feat/x'
          ? held.promise
          : none(selector || branch),
    );

    await settle();
    state.branch = 'main';
    await step();
    // gh by name lists only open pull requests
    assert.deepEqual(named(), ['feat/x']);

    if (meanwhile === 'another unfollowed') watch.unfollow('https://x.test/9');

    held.resolve(pr('MERGED'));
    await settle();
    assert.deepEqual(followed(), ['#7 MERGED']);
  });

for (const later of ['MERGED', 'CLOSED', 'unfollowed'] as const)
  test(`a branch read that began before a later read of its pull request can't undo it: ${later}`, async (t) => {
    let reads = 0;
    const held = Promise.withResolvers<string>();

    const { watch, state, step, wait, named, followed } = harness(
      t.onTestFinished,
      (selector, branch) =>
        selector === url7
          ? pr(later === 'CLOSED' ? 'CLOSED' : 'MERGED')
          : selector === '' && branch === 'feat/x'
            ? ++reads === 1
              ? pr('OPEN')
              : held.promise
            : none(selector || branch),
    );

    await settle();
    await wait(90_000);
    assert.equal(reads, 2);
    state.branch = 'main';
    await step();
    assert.deepEqual(named(), [url7]);

    if (later === 'unfollowed') watch.unfollow(url7);

    held.resolve(pr('OPEN'));
    await settle();

    assert.deepEqual(
      followed(),
      later === 'MERGED' ? ['#7 MERGED'] : undefined,
    );
  });

test("a held branch read whose checks adjustment fails after the checkout left reports it as the followed pull request's", async (t) => {
  const url = 'https://github.com/o/r/pull/7';
  const held = Promise.withResolvers<string>();

  const { watch, state, step, wait } = harness(
    t.onTestFinished,
    (selector, branch) =>
      selector === url
        ? view({
            number: 7,
            url,
            state: 'OPEN',
            statusCheckRollup: [
              {
                __typename: 'CheckRun',
                name: 'ci',
                status: 'COMPLETED',
                conclusion: 'SUCCESS',
              },
            ],
          })
        : selector === '' && branch === 'feat/x'
          ? held.promise
          : none(selector || branch),
  );

  await settle();
  state.branch = 'main';
  await step();
  held.resolve(view({ number: 7, url, state: 'OPEN', statusCheckRollup: [] }));
  await settle();
  assert.equal(watch.snapshot?.followed?.[0]?.url, url);
  assert.match(watch.snapshot?.followedFailure ?? '', /^#7: /);
  assert.equal(watch.snapshot?.pullRequestFailure, undefined);
  await wait(90_000);
  assert.equal(watch.snapshot?.followed?.[0]?.checks, 'passing');
  assert.equal(watch.snapshot?.followedFailure, undefined);
});

test("a failure handed to the followed pull request doesn't come back as the branch's own when the checkout returns", async (t) => {
  const url = 'https://github.com/o/r/pull/7';
  const held = Promise.withResolvers<string>();
  let reads = 0;

  const { watch, state, step } = harness(
    t.onTestFinished,
    (selector, branch) =>
      selector === '' && branch === 'feat/x'
        ? ++reads === 1
          ? held.promise
          : new Promise<string>(() => {})
        : none(selector || branch),
  );

  await settle();
  state.branch = 'main';
  await step();
  held.resolve(view({ number: 7, url, state: 'OPEN', statusCheckRollup: [] }));
  await settle();
  assert.match(watch.snapshot?.followedFailure ?? '', /^#7: /);
  // back before the next read of the branch answers, so only what the held read left can show
  state.branch = 'feat/x';
  await step();
  assert.equal(watch.snapshot?.branch, 'feat/x');
  assert.equal(watch.snapshot?.pullRequestFailure, undefined);
});

test('a held branch read that answers closed after the checkout left is not followed', async (t) => {
  const held = Promise.withResolvers<string>();

  const { state, step, followed } = harness(
    t.onTestFinished,
    (selector, branch) =>
      selector === '' && branch === 'feat/x'
        ? held.promise
        : none(selector || branch),
  );

  await settle();
  state.branch = 'main';
  await step();
  held.resolve(pr('CLOSED'));
  await settle();
  assert.equal(followed(), undefined);
});

test("a read by URL that began before a visit to the branch can't close what the visit read as merged", async (t) => {
  const held = Promise.withResolvers<string>();
  let reads = 0;

  const { state, step, wait, followed } = harness(
    t.onTestFinished,
    (selector, branch) =>
      selector === url7
        ? held.promise
        : selector === '' && branch === 'feat/x'
          ? pr(++reads === 1 ? 'OPEN' : 'MERGED')
          : none(selector || branch),
  );

  await settle();
  state.branch = 'main';
  await step();
  await wait(90_000);
  state.branch = 'feat/x';
  await step();
  state.branch = 'main';
  await step();
  assert.deepEqual(followed(), ['#7 MERGED']);
  // a pull request closed, then reopened and merged
  held.resolve(pr('CLOSED'));
  await settle();
  assert.deepEqual(followed(), ['#7 MERGED']);
});

test('a pull request found late still sorts by when its branch was left', async (t) => {
  const held = Promise.withResolvers<string>();

  const { state, step, followed } = harness(
    t.onTestFinished,
    (selector, branch) =>
      selector === 'feat/a'
        ? unavailable()
        : selector === 'feat/b'
          ? pr('OPEN', { number: 2, branch: 'feat/b' })
          : selector === '' && branch === 'feat/a'
            ? held.promise
            : none(selector || branch),
    { branch: 'feat/a' },
  );

  await settle();
  state.branch = 'feat/b';
  await step();
  state.branch = 'main';
  await step();
  assert.deepEqual(followed(), ['#2 OPEN']);
  held.resolve(pr('OPEN', { number: 1, branch: 'feat/a' }));
  await settle();
  assert.deepEqual(followed(), ['#2 OPEN', '#1 OPEN']);
});

test('a read by name that a project change overtakes follows nothing', async (t) => {
  const held = Promise.withResolvers<string>();
  let project = 'a';

  const { state, step, named, followed } = harness(
    t.onTestFinished,
    (selector, branch) =>
      selector === 'feat/x' ? held.promise : none(selector || branch),
    { project: async () => project },
  );

  await settle();
  state.branch = 'main';
  await step();
  assert.deepEqual(named(), ['feat/x']);
  project = 'b';
  held.resolve(pr('OPEN'));
  await settle();
  assert.equal(followed(), undefined);
});

test('each branch left keeps its own pull request, newest first', async (t) => {
  const { watch, state, step, wait, named, followed } = harness(
    t.onTestFinished,
    (selector, branch) => {
      const name = selector.startsWith('https://')
        ? selector === 'https://x.test/1'
          ? 'feat/a'
          : 'feat/b'
        : branch;

      return selector === '' && branch === 'main'
        ? none(branch)
        : pr('OPEN', { number: name === 'feat/a' ? 1 : 2, branch: name });
    },
    { branch: 'feat/a' },
  );

  await settle();
  state.branch = 'feat/b';
  await step();
  state.branch = 'main';
  await step();
  assert.deepEqual(followed(), ['#2 OPEN', '#1 OPEN']);
  await wait(85_000);
  assert.deepEqual(named(), ['https://x.test/1', 'https://x.test/2']);
  watch.unfollow('https://x.test/1');
  assert.deepEqual(followed(), ['#2 OPEN']);
});

test('a pull request taken back by a visit to its branch is followed again on leaving, by its URL', async (t) => {
  let reads = 0;
  const held = Promise.withResolvers<string>();

  const { watch, state, published, step, wait, named, followed } = harness(
    t.onTestFinished,
    (selector, branch) =>
      selector === url7
        ? pr('MERGED')
        : selector === '' && branch === 'feat/x'
          ? pr('OPEN')
          : selector === '' && branch === 'main' && ++reads === 1
            ? held.promise
            : none(selector || branch),
  );

  try {
    await settle();
    state.branch = 'main';
    await step();
    state.branch = 'feat/x';
    await step();
    assert.equal(watch.snapshot?.followed, undefined);
    state.branch = 'main';
    await step();
    assert.deepEqual(published.at(-1)?.branch, 'main');
    assert.deepEqual(followed(), ['#7 OPEN']);
    await wait(75_000);
    // main was left while its own read was held, so only main is read by name
    assert.deepEqual(named(), ['main', url7]);
    assert.deepEqual(followed(), ['#7 MERGED']);
  } finally {
    held.reject(none('main'));
  }
});

test('a branch left with no pull request read, and the branch checked out before startup, each get one read by name', async (t) => {
  for (const before of ['none', 'failed', 'other', 'status'] as const) {
    const { state, step, named, followed } = harness(
      t.onTestFinished,
      (selector, branch) =>
        selector === 'feat/x'
          ? pr('OPEN')
          : selector === '' && branch === 'feat/x'
            ? before === 'failed'
              ? '{}'
              : before === 'other'
                ? pr('OPEN', { number: 9, branch: 'feat/other' })
                : none(branch)
            : none(selector || branch),
    );

    await settle();

    if (before === 'status') {
      state.status = false;
      await step();
      state.status = true;
    }

    state.branch = 'main';
    await step();
    assert.deepEqual(named(), ['feat/x'], before);
    assert.deepEqual(followed(), ['#7 OPEN'], before);
  }

  const { watch, named, followed } = harness(
    t.onTestFinished,
    (selector, branch) =>
      selector === 'feat/x' ? pr('OPEN') : none(selector || branch),
    {
      branch: 'main',
      previous: 'refs/heads/feat/x',
      project: async () => 'project',
    },
  );

  await settle();
  assert.deepEqual(named(), ['feat/x']);
  assert.deepEqual(followed(), ['#7 OPEN']);
  assert.equal(watch.snapshot?.followedProject, 'project');
});

test('a name whose read fails is read again 90 seconds later, and one gh answered is not', async (t) => {
  for (const first of ['unexpected', 'timeout', 'none'] as const) {
    let reads = 0;

    const { state, step, wait, named, followed } = harness(
      t.onTestFinished,
      (selector, branch) =>
        selector === 'feat/x'
          ? ++reads > 1
            ? pr('OPEN')
            : first === 'unexpected'
              ? '{}'
              : first === 'timeout'
                ? timedOut()
                : none(selector)
          : none(selector || branch),
    );

    await settle();
    state.branch = 'main';
    await step();
    await wait(85_000);
    assert.deepEqual(named(), ['feat/x'], first);
    await step();

    assert.deepEqual(
      named(),
      first === 'none' ? ['feat/x'] : ['feat/x', 'feat/x'],
      first,
    );

    assert.deepEqual(
      followed(),
      first === 'none' ? undefined : ['#7 OPEN'],
      first,
    );
  }
});

test('a read by name follows only an open pull request of that branch, and a failed read of the branch checked out before startup reads nothing', async (t) => {
  for (const answer of [pr('OPEN', { branch: 'feat/other' }), pr('MERGED')]) {
    const { state, step, wait, named, followed } = harness(
      t.onTestFinished,
      (selector, branch) =>
        selector === 'feat/x' ? answer : none(selector || branch),
    );

    await settle();
    state.branch = 'main';
    await step();
    await wait(90_000);
    assert.deepEqual(named(), ['feat/x']);
    assert.equal(followed(), undefined);
  }

  const { named } = harness(
    t.onTestFinished,
    (selector, branch) =>
      selector === 'feat/x' ? pr('OPEN') : none(selector || branch),
    { branch: 'main' },
  );

  await settle();
  assert.deepEqual(named(), []);
});

test('a followed read that fails unexpectedly says which pull request, and the next good read clears it', async (t) => {
  let answer = view({ state: 'OPEN', statusCheckRollup: [] });
  let failing = false;

  const { watch, state, step, wait, followed } = harness(
    t.onTestFinished,
    (selector, branch) =>
      selector === 'https://x.test/4' ||
      (selector === '' && branch === 'feat/x')
        ? answer
        : none(selector || branch),
    {
      project: async () => {
        if (failing) throw new Error('project read failed');

        return 'project';
      },
    },
  );

  await settle();
  state.branch = 'main';
  await step();
  answer = '{}';
  await wait(90_000);
  assert.match(watch.snapshot?.followedFailure ?? '', /^#4: /);
  assert.deepEqual(followed(), ['#4 OPEN']);
  answer = view({ state: 'OPEN', statusCheckRollup: [] });
  await wait(90_000);
  assert.equal(watch.snapshot?.followedFailure, undefined);
  failing = true;
  await wait(90_000);
  assert.equal(watch.snapshot?.followedFailure, 'project read failed');
});

test('followed pull requests go when the project changes', async (t) => {
  for (const when of ['between rounds', 'during a round'] as const) {
    let project = 'a';
    let held: PromiseWithResolvers<string> | undefined;

    const { watch, state, published, step, wait, followed } = harness(
      t.onTestFinished,
      (selector, branch) =>
        selector === url7
          ? when === 'during a round'
            ? (held = Promise.withResolvers()).promise
            : pr('OPEN')
          : selector === '' && branch === 'feat/x'
            ? pr('OPEN')
            : none(selector || branch),
      { project: async () => project },
    );

    await settle();
    state.branch = 'main';
    await step();
    assert.deepEqual(followed(), ['#7 OPEN']);
    assert.equal(watch.snapshot?.followedProject, 'a');

    if (when === 'between rounds') project = 'b';

    await wait(85_000);

    if (held) {
      project = 'b';
      held.resolve(pr('MERGED'));
      await settle();
    }

    assert.equal(watch.snapshot?.followed, undefined, when);

    assert.ok(
      published.every(
        ({ followed, followedProject }) => !followed || followedProject === 'a',
      ),
      when,
    );
  }

  {
    let project = 'a';

    const { state, step, wait, named, followed } = harness(
      t.onTestFinished,
      (selector, branch) =>
        selector === 'feat/x' ? pr('OPEN') : none(selector || branch),
      { project: async () => project },
    );

    await settle();
    project = 'b';
    state.branch = 'main';
    await step();
    await wait(90_000);
    assert.deepEqual(named(), []);
    assert.equal(followed(), undefined);
  }

  {
    let project = 'a';

    const { state, step, wait, followed } = harness(
      t.onTestFinished,
      (selector, branch) =>
        selector === '' && branch === 'feat/x'
          ? pr('MERGED')
          : none(selector || branch),
      { project: async () => project },
    );

    await settle();
    state.branch = 'main';
    await step();
    assert.deepEqual(followed(), ['#7 MERGED']);
    project = 'b';
    await wait(90_000);
    assert.equal(followed(), undefined);
  }

  {
    let project = 'a';

    const { state, step, wait, named, followed } = harness(
      t.onTestFinished,
      (selector, branch) =>
        selector === '' && branch === 'feat/x' && project === 'a'
          ? pr('OPEN')
          : none(selector || branch),
      { project: async () => project },
    );

    await settle();
    project = 'b';
    await wait(90_000);
    state.branch = 'main';
    await step();
    assert.deepEqual(named(), ['feat/x']);
    assert.equal(followed(), undefined);
  }
});

test("an older read by name can't answer for the branch's next departure", async (t) => {
  const first = Promise.withResolvers<string>();
  let reads = 0;

  const { state, step, named, followed } = harness(
    t.onTestFinished,
    (selector, branch) =>
      selector === 'feat/x'
        ? ++reads === 1
          ? first.promise
          : pr('OPEN')
        : none(selector || branch),
  );

  await settle();
  state.branch = 'main';
  await step();
  state.branch = 'feat/x';
  await step();
  state.branch = 'main';
  await step();
  assert.deepEqual(named(), ['feat/x']);
  // the pull request was opened after the first read began
  first.reject(none('feat/x'));
  await settle();
  await step();
  assert.deepEqual(named(), ['feat/x', 'feat/x']);
  assert.deepEqual(followed(), ['#7 OPEN']);
});

test("a read by name that began before its pull request was unfollowed can't bring it back", async (t) => {
  const own = Promise.withResolvers<string>();
  const byName = Promise.withResolvers<string>();

  const { watch, state, step, followed } = harness(
    t.onTestFinished,
    (selector, branch) =>
      selector === 'feat/x'
        ? byName.promise
        : selector === '' && branch === 'feat/x'
          ? own.promise
          : none(selector || branch),
  );

  await settle();
  state.branch = 'main';
  await step();
  own.resolve(pr('MERGED'));
  await settle();
  assert.deepEqual(followed(), ['#7 MERGED']);
  watch.unfollow(url7);
  byName.resolve(pr('OPEN'));
  await settle();
  assert.equal(followed(), undefined);
});

test('a failed read of the branch checked out before startup is reported and asked again', async (t) => {
  let asked = 0;

  const { watch, step, named, followed } = harness(
    t.onTestFinished,
    (selector, branch) =>
      selector === 'feat/x' ? pr('OPEN') : none(selector || branch),
    {
      branch: 'main',
      previous: () => {
        if (++asked === 1)
          throw Object.assign(new Error('spawn git EMFILE'), {
            code: 'EMFILE',
          });

        return 'refs/heads/feat/x';
      },
    },
  );

  await settle();

  assert.equal(
    watch.snapshot?.followedFailure,
    'previous branch: spawn git EMFILE',
  );

  assert.deepEqual(named(), []);
  await step();
  assert.deepEqual(followed(), ['#7 OPEN']);
  assert.equal(watch.snapshot?.followedFailure, undefined);
  await step();
  assert.equal(asked, 2);
});

test('a branch named like an option is not read by name', async (t) => {
  const { state, step, wait, named } = harness(
    t.onTestFinished,
    (selector, branch) => none(selector || branch),
    { branch: '-x' },
  );

  await settle();
  state.branch = 'main';
  await step();
  await wait(90_000);
  assert.deepEqual(named(), []);
});

test('while gh has no answer, the branches left cost one read by name per interval', async (t) => {
  const { state, step, wait, named } = harness(
    t.onTestFinished,
    () => unavailable(),
    { branch: 'feat/a' },
  );

  await settle();
  state.branch = 'feat/b';
  await step();
  state.branch = 'main';
  await step();
  assert.deepEqual(named(), ['feat/a', 'feat/b']);
  await wait(90_000);
  assert.deepEqual(named(), ['feat/a', 'feat/b', 'feat/a']);
});

test('leaving a detached head reads nothing by name', async (t) => {
  const { state, step, wait, named, followed } = harness(
    t.onTestFinished,
    (selector, branch) =>
      selector === url7 || (selector === '' && branch === 'feat/x')
        ? pr('OPEN')
        : none(selector || branch),
  );

  await settle();
  state.branch = 'HEAD';
  await step();
  state.branch = 'main';
  await step();
  await wait(90_000);
  assert.deepEqual(named(), [url7]);
  assert.deepEqual(followed(), ['#7 OPEN']);
});
