import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test, vi } from 'vitest';
import type { FamiliarAction } from '../../../src/agents/familiar-report.js';
import { NativeStop, NativeStopTimeout } from '../../../src/agents/shutdown.js';
import { reviewerCommand } from '../../../src/core/review/review.js';
import { Reviewers } from '../../../src/core/review/reviewers.js';
import type { Reviewer } from '../../../src/core/review/reviewers.js';
import { callControl } from '../../../src/persistence/control.js';
import { quote } from '../../../src/shell.js';
import { orderedCleanup } from '../../fixtures/cleanup.js';
import { unitCoordinationFixture } from '../../fixtures/coordination.js';
import { scratch } from '../../fixtures/scratch.js';
import { until, within } from '../../fixtures/within.js';

/** a coordinator whose familiar mailbox asks its reviewers first, with `claude` and `codex` fixtures on a private PATH. */
async function setup(register: Parameters<typeof orderedCleanup>[0]) {
  const { start } = await unitCoordinationFixture(orderedCleanup(register));
  const session = await start();
  const { coordinator, coordination, a } = session;
  coordination.ownFamiliars = (action) => coordinator.reviewers.report(action);
  const root = await scratch('witch-reviewers-');
  const bin = join(root, 'bin');
  await mkdir(bin);

  await copyFile(
    fileURLToPath(new URL('../../fixtures/claude-task.mjs', import.meta.url)),
    join(bin, 'claude'),
  );

  await chmod(join(bin, 'claude'), 0o700);

  await writeFile(
    join(bin, 'codex'),
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fileURLToPath(new URL('../../fixtures/codex.mjs', import.meta.url)))} "$@"\n`,
  );

  await chmod(join(bin, 'codex'), 0o700);
  const prefix = coordination.commandPrefixes().familiar;

  /** a reviewer that runs in its own directory, so its fixture's `launched.json` names its native pid. */
  const reviewer = async (
    name: string,
    runtime: 'claude' | 'codex' = 'claude',
    mode = 'success',
  ): Promise<Reviewer & { directory: string }> => {
    const directory = join(root, name);
    await mkdir(directory);
    await writeFile(join(directory, 'brief.md'), 'Review plan.md.\n');

    const command = reviewerCommand({
      prefix,
      route: {
        runtime,
        model: runtime === 'claude' ? 'claude-opus-5-5' : 'gpt-6.1-sol',
        reason: 'test',
      },
      name,
      reportFile: join(directory, 'report.md'),
      briefFile: join(directory, 'brief.md'),
    });

    return {
      name,
      directory,
      reportFile: join(directory, 'report.md'),
      command: `cd ${quote(directory)} && PATH=${quote(bin)}:"$PATH" WITCH_FAMILIAR_FIXTURE=${mode} ${command}`,
    };
  };

  return { coordinator, coordination, a, root, reviewer };
}

async function nativePid(directory: string): Promise<number> {
  const launched = join(directory, 'launched.json');
  let pid: number | undefined;

  await until(
    'the native reviewer to launch',
    // the fixture writes the file in place, so a poll can find it still empty
    async () => {
      try {
        pid = (JSON.parse(await readFile(launched, 'utf8')) as { pid: number })
          .pid;

        return true;
      } catch {
        return false;
      }
    },
    500,
  );

  return pid!;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
}

test('a Witch-launched reviewer registers, reports and exits', async (t) => {
  const { coordinator, root, reviewer } = await setup(t.onTestFinished);
  const one = await reviewer('review-a1-1-claude-0');

  const [result] = await within(
    coordinator.reviewers.run({
      cwd: root,
      reviewers: [one],
      signal: new AbortController().signal,
    }),
    30_000,
    'the reviewer',
  );

  assert.equal(result!.code, 0);
  assert.equal(result!.status, 'completed');
  assert.equal(result!.model, 'claude-response');
  assert.equal(result!.report, 'Full review.\n'.repeat(7000));

  const entry = coordinator.snapshot.subagents.find(
    ({ name }) => name === one.name,
  );

  assert.equal(entry?.status, 'completed');

  const rows = coordinator.snapshot.items.filter(
    (item) => item.kind === 'tool' && item.title?.includes(one.name),
  );

  assert.ok(rows.length >= 2, 'start and end rows');
});

test('an unexpected name falls through to the live session', async (t) => {
  const { coordination, a } = await setup(t.onTestFinished);
  const forwarded: [FamiliarAction, number][] = [];

  a.sessions.at(-1)!.session.familiar = {
    report: async (action, deadline) => {
      forwarded.push([action, deadline]);

      return { kind: 'familiar-registered' };
    },
  };

  const action: FamiliarAction = {
    kind: 'familiar-register',
    run: randomUUID(),
    name: 'not-a-reviewer',
    runtime: 'claude',
  };

  const deadline = Date.now() + 5000;

  const outcome = await callControl(
    coordination.familiarBinding(),
    action,
    deadline,
  );

  assert.equal(outcome.kind, 'familiar-registered');
  assert.deepEqual(forwarded, [[action, deadline]]);
});

test('a familiar request fails the reviewer', async (t) => {
  const { coordinator, root, reviewer } = await setup(t.onTestFinished);
  const asking = await reviewer('review-a1-1-codex-0', 'codex');

  const [result] = await within(
    coordinator.reviewers.run({
      cwd: root,
      reviewers: [asking],
      signal: new AbortController().signal,
    }),
    30_000,
    'the asking reviewer',
  );

  assert.notEqual(result!.code, 0);
  assert.equal(result!.status, 'failed');
  assert.match(result!.report, /runs read-only and cannot ask for anything/);
});

test('a reviewer that cannot spawn ends the run with its launch error', async () => {
  const root = await scratch('witch-reviewers-');

  const [result] = await within(
    new Reviewers(() => {}).run({
      cwd: join(root, 'missing'),
      reviewers: [
        { name: 'r', command: 'true', reportFile: join(root, 'report.md') },
      ],
      signal: new AbortController().signal,
    }),
    5000,
    'the failed spawn',
  );

  assert.equal(result!.code, null);
  assert.match(result!.diagnostics ?? '', /spawn \/bin\/sh ENOENT/);
});

test('late updates never reopen a finished reviewer', () => {
  const events: string[] = [];

  const reviewers = new Reviewers(({ subagent }) =>
    events.push(subagent.status),
  );

  const controller = new AbortController();

  const running = reviewers.run({
    cwd: '/',
    reviewers: [{ name: 'r', command: 'sleep 5', reportFile: '/x' }],
    signal: controller.signal,
  });

  const run = randomUUID();

  assert.deepEqual(
    reviewers.report({
      kind: 'familiar-register',
      run,
      name: 'r',
      runtime: 'claude',
    }),
    { kind: 'familiar-registered' },
  );

  const update = (sequence: number, status: 'running' | 'completed') =>
    reviewers.report({
      kind: 'familiar-update',
      run,
      sequence,
      progress: { status },
    });

  assert.deepEqual(update(1, 'completed'), { kind: 'familiar-updated' });
  assert.deepEqual(update(0, 'running'), { kind: 'familiar-updated' });
  assert.throws(() => update(2, 'running'), /already ended/);
  assert.deepEqual(events, ['running', 'completed']);
  controller.abort();

  return running;
});

test('a repeated registration is acknowledged again but published once, and another run cannot take its name', () => {
  const events: string[] = [];

  const reviewers = new Reviewers(({ subagent }) =>
    events.push(`${subagent.run} ${subagent.status}`),
  );

  const controller = new AbortController();

  const running = reviewers.run({
    cwd: '/',
    reviewers: [{ name: 'r', command: 'sleep 5', reportFile: '/x' }],
    signal: controller.signal,
  });

  const run = randomUUID();

  const register = (id: string) =>
    reviewers.report({
      kind: 'familiar-register',
      run: id,
      name: 'r',
      runtime: 'claude',
    });

  assert.deepEqual(register(run), { kind: 'familiar-registered' });
  assert.deepEqual(register(run), { kind: 'familiar-registered' });
  const other = randomUUID();
  assert.throws(() => register(other), /already registered/);
  assert.deepEqual(events, [`${run} running`]);
  assert.ok(reviewers.owns(`claude-familiar/${run}`));
  assert.ok(!reviewers.owns(`claude-familiar/${other}`));
  controller.abort();

  return running;
});

test("a command's stderr and a report read error come back as its diagnostics", async () => {
  const root = await scratch('witch-reviewers-');

  const [result] = await new Reviewers(() => {}).run({
    cwd: root,
    reviewers: [
      {
        name: 'r',
        command: 'echo first >&2; echo cannot open report >&2; exit 3',
        reportFile: join(root, 'report.md'),
      },
    ],
    signal: new AbortController().signal,
  });

  assert.deepEqual(result, {
    code: 3,
    diagnostics: `first\ncannot open report\nENOENT: no such file or directory, open '${join(root, 'report.md')}'`,
    report: '',
  });
});

test('an aborted signal spawns nothing', async () => {
  const root = await scratch('witch-reviewers-');
  const controller = new AbortController();
  controller.abort();

  const results = await new Reviewers(() => {}).run({
    cwd: root,
    reviewers: [
      {
        name: 'r',
        command: 'touch started',
        reportFile: join(root, 'report.md'),
      },
    ],
    signal: controller.signal,
  });

  assert.deepEqual(results, [{ code: null, report: '' }]);
  await assert.rejects(readFile(join(root, 'started')), { code: 'ENOENT' });
});

test('cleanup waits while macOS answers EPERM for an exiting group', async () => {
  const root = await scratch('witch-reviewers-');
  const kill = process.kill.bind(process);
  const sent: (string | number | undefined)[] = [];
  let probes = 0;

  const refuse = (code: string) =>
    Object.assign(new Error(`kill ${code}`), { code });

  const spy = vi
    .spyOn(process, 'kill')
    .mockImplementation((pid: number, signal?: string | number) => {
      if (pid >= 0) return kill(pid, signal);

      sent.push(signal);

      if (signal !== 0) throw refuse('EPERM');

      throw refuse(++probes <= 3 ? 'EPERM' : 'ESRCH');
    });

  try {
    const [result] = await new Reviewers(() => {}).run({
      cwd: root,
      reviewers: [
        {
          name: 'r',
          command: 'true',
          reportFile: join(root, 'report.md'),
        },
      ],
      signal: new AbortController().signal,
    });

    assert.equal(result!.code, 0);
    assert.deepEqual(sent, ['SIGKILL', 0, 0, 0, 0]);
  } finally {
    spy.mockRestore();
  }
});

test('a reviewer that outlives the stop deadline ends the run at the deadline', async () => {
  const root = await scratch('witch-reviewers-');
  const kill = process.kill.bind(process);
  const groups = new Set<number>();

  // group signals never arrive, as for a wrapper that survives them
  const spy = vi
    .spyOn(process, 'kill')
    .mockImplementation((pid: number, signal?: string | number) => {
      if (pid >= 0) return kill(pid, signal);

      groups.add(-pid);

      return true;
    });

  try {
    const controller = new AbortController();
    const events: string[] = [];

    const reviewers = new Reviewers(({ subagent }) =>
      events.push(subagent.status),
    );

    const running = reviewers.run({
      cwd: root,
      reviewers: [
        {
          name: 'r',
          command: 'exec sleep 30',
          reportFile: join(root, 'report.md'),
        },
      ],
      signal: controller.signal,
    });

    reviewers.report({
      kind: 'familiar-register',
      run: randomUUID(),
      name: 'r',
      runtime: 'claude',
    });

    controller.abort(new NativeStop({ deadline: performance.now() + 1500 }));

    await assert.rejects(
      within(running, 3000, 'the missed stop'),
      NativeStopTimeout,
    );

    assert.deepEqual(events, ['running', 'stopped']);
  } finally {
    spy.mockRestore();

    for (const group of groups) kill(-group, 'SIGKILL');
  }
});

test('an aborted reviewer behind a shell redirect gets its SIGTERM grace', async () => {
  const root = await scratch('witch-reviewers-');
  await writeFile(join(root, 'brief'), '');

  await writeFile(
    join(root, 'handler.mjs'),
    `import { writeFileSync } from 'node:fs';
process.on('SIGTERM', () => setTimeout(() => {
  writeFileSync('stopped', 'yes');
  process.exit(0);
}, 200));
writeFileSync('ready', 'yes');
setInterval(() => {}, 1000);
`,
  );

  const controller = new AbortController();

  const running = new Reviewers(() => {}).run({
    cwd: root,
    reviewers: [
      {
        name: 'r',
        // the trailing exit keeps the shell from exec'ing the redirected command
        command: `${quote(process.execPath)} handler.mjs < brief; exit $?`,
        reportFile: join(root, 'report.md'),
      },
    ],
    signal: controller.signal,
  });

  await until('the handler', async () =>
    readFile(join(root, 'ready'), 'utf8').then(
      () => true,
      () => false,
    ),
  );

  controller.abort();
  await within(running, 5000, 'the stop');
  assert.equal(await readFile(join(root, 'stopped'), 'utf8'), 'yes');
});

test('an abort after the commands exit ends cleanup at its own deadline and stops probing', async () => {
  const root = await scratch('witch-reviewers-');
  const kill = process.kill.bind(process);
  const sent: (string | number | undefined)[] = [];

  // the group outlives every signal, as for a member stuck in the kernel
  const spy = vi
    .spyOn(process, 'kill')
    .mockImplementation((pid: number, signal?: string | number) => {
      if (pid >= 0) return kill(pid, signal);

      sent.push(signal);

      return true;
    });

  try {
    const controller = new AbortController();

    const running = new Reviewers(() => {}).run({
      cwd: root,
      reviewers: [
        { name: 'r', command: 'true', reportFile: join(root, 'report.md') },
      ],
      signal: controller.signal,
    });

    await until('the cleanup wait', () => sent.includes(0));
    controller.abort(new NativeStop({ deadline: performance.now() + 500 }));

    await assert.rejects(
      within(running, 3000, 'the missed stop'),
      NativeStopTimeout,
    );

    // each poll probes once more as it wakes past the deadline
    await delay(300);
    const probes = sent.length;
    await delay(200);
    assert.equal(sent.length, probes);
  } finally {
    spy.mockRestore();
  }
});

test('abort stops every reviewer', async (t) => {
  const { coordinator, root, reviewer } = await setup(t.onTestFinished);
  const first = await reviewer('review-a1-1-claude-0', 'claude', 'gated');
  const second = await reviewer('review-a1-1-claude-1', 'claude', 'gated');
  const controller = new AbortController();

  const running = coordinator.reviewers.run({
    cwd: root,
    reviewers: [first, second],
    signal: controller.signal,
  });

  const pids = [
    await nativePid(first.directory),
    await nativePid(second.directory),
  ];

  controller.abort();
  const results = await within(running, 10_000, 'the stop');

  for (const result of results) assert.notEqual(result.code, 0);

  for (const pid of pids) assert.equal(alive(pid), false);

  assert.ok(
    !coordinator.snapshot.subagents.some(({ status }) => status === 'running'),
  );
});

test('abort stops a native reviewer that ignores SIGTERM', async (t) => {
  const { coordinator, root, reviewer } = await setup(t.onTestFinished);

  const stubborn = await reviewer(
    'review-a1-1-claude-0',
    'claude',
    'ignore-term',
  );

  const controller = new AbortController();

  const running = coordinator.reviewers.run({
    cwd: root,
    reviewers: [stubborn],
    signal: controller.signal,
  });

  const pid = await nativePid(stubborn.directory);
  const deadline = performance.now() + 1500;
  controller.abort(new NativeStop({ deadline }));
  await within(running, 3000, 'the deadline stop');
  assert.equal(alive(pid), false);
});

test('a killed reviewer gets a terminal event and no survivor', async (t) => {
  const { coordinator, root, reviewer } = await setup(t.onTestFinished);
  const killed = await reviewer('review-a1-1-claude-0', 'claude', 'gated');

  const running = coordinator.reviewers.run({
    cwd: root,
    reviewers: [killed],
    signal: new AbortController().signal,
  });

  const pid = await nativePid(killed.directory);

  await until(
    'registration',
    () =>
      coordinator.snapshot.subagents.some(
        ({ name, status }) => name === killed.name && status === 'running',
      ),
    500,
  );

  const group = execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], {
    encoding: 'utf8',
  }).trim();

  // the shell and the wrapper die outright, leaving the native CLI behind in their group
  for (const member of execFileSync('pgrep', ['-g', group], {
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .map(Number))
    if (member !== pid) process.kill(member, 'SIGKILL');

  const [result] = await within(running, 10_000, 'the killed reviewer');
  assert.equal(result!.status, 'failed');
  assert.match(result!.diagnostics ?? '', /^killed by SIGKILL$/m);
  assert.equal(alive(pid), false);

  assert.equal(
    coordinator.snapshot.subagents.find(({ name }) => name === killed.name)
      ?.status,
    'failed',
  );

  assert.ok(
    coordinator.snapshot.items.some(
      (item) =>
        item.title?.startsWith('Familiar failed') &&
        item.title.includes(killed.name),
    ),
  );
});

test("a native session closing leaves Witch's reviewers running", async (t) => {
  const { coordinator, a, root, reviewer } = await setup(t.onTestFinished);
  const held = await reviewer('review-a1-1-claude-0', 'claude', 'gated');

  const running = coordinator.reviewers.run({
    cwd: root,
    reviewers: [held],
    signal: new AbortController().signal,
  });

  await nativePid(held.directory);

  const entry = () =>
    coordinator.snapshot.subagents.find(({ name }) => name === held.name);

  await until('registration', () => entry()?.status === 'running', 500);
  a.sessions[0]!.options.onEvent({ type: 'closed' });
  assert.equal(entry()?.status, 'running');
  await writeFile(join(held.directory, 'exit'), '');
  const [result] = await within(running, 30_000, 'the held reviewer');
  assert.equal(result!.status, 'completed');
  assert.equal(entry()?.status, 'completed');

  const end = coordinator.snapshot.items.find(
    (item) =>
      item.title?.startsWith('Familiar completed') &&
      item.title.includes(held.name),
  );

  assert.equal(end?.text, 'Full review.\n'.repeat(7000));
});

/** a writer that leaves the reviewer's group, so the kill after the exit can't reach it, and marks `<ready>.exited` once its shell is gone. */
const detached = (ready: string, after: string) =>
  `perl -MPOSIX -e 'setsid; open my $f, ">", $ARGV[0]; print $f $$; close $f; select undef, undef, undef, 0.05 while kill 0, $ARGV[1]; open $f, ">", "$ARGV[0].exited"; close $f; ${after}' ${quote(ready)} $$ & until [ -s ${quote(ready)} ]; do sleep 0.05; done; exit 3`;

test('stderr written after a command exits still reaches its diagnostics', async () => {
  const root = await scratch('witch-reviewers-');

  const [result] = await new Reviewers(() => {}).run({
    cwd: root,
    reviewers: [
      {
        name: 'r',
        command: detached(
          join(root, 'ready'),
          'select undef, undef, undef, 0.3; print STDERR "late\\n"',
        ),
        reportFile: join(root, 'report.md'),
      },
    ],
    signal: new AbortController().signal,
  });

  assert.deepEqual(result, {
    code: 3,
    diagnostics: `late\nENOENT: no such file or directory, open '${join(root, 'report.md')}'`,
    report: '',
  });
});

test('a stop ends the wait for stderr a descendant holds open', async () => {
  const root = await scratch('witch-reviewers-');
  const ready = join(root, 'ready');
  const controller = new AbortController();

  try {
    const running = new Reviewers(() => {}).run({
      cwd: root,
      reviewers: [
        {
          name: 'r',
          command: detached(ready, 'select undef, undef, undef, 6'),
          reportFile: join(root, 'report.md'),
        },
      ],
      signal: controller.signal,
    });

    let ended = false;

    void running.then(
      () => (ended = true),
      () => {},
    );

    await until('the exited shell', () =>
      readFile(`${ready}.exited`).then(
        () => true,
        () => false,
      ),
    );

    // past the group's cleanup, so the run is waiting on the writer's stderr
    await delay(300);
    assert.equal(ended, false);
    controller.abort(new NativeStop({ deadline: performance.now() + 500 }));
    await within(running, 2000, 'the stopped run');
  } finally {
    const writer = Number(await readFile(ready, 'utf8').catch(() => ''));

    if (writer) process.kill(writer, 'SIGKILL');
  }
});
