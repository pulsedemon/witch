import assert from 'node:assert/strict';

import { writeFile, readFile } from 'node:fs/promises';

import { basename, join } from 'node:path';

import type {
  AgentAdapter,
  AgentEvent,
  AgentSession,
  SessionOptions,
  TurnResult,
  UserRequest,
  UserResponse,
} from './types.js';

import { setTimeout as delay } from 'node:timers/promises';

import { familiarMarker } from './familiar-report.js';

import { skillCall } from '../core/prompts.js';

import type { ProcessIdentity } from '../core/state.js';

import {
  identifyProcesses,
  processArguments,
  ps,
  sameProcess,
} from '../persistence/process.js';

import { errorMessage } from '../errors.js';

export type NativeScenario =
  'basic' | 'control' | 'background' | 'spell' | 'idle-run';

export function probeApproval(request: UserRequest): UserResponse {
  assert.equal(request.kind, 'approval', request.detail);

  const { command } = JSON.parse(request.detail) as { command?: string };

  assert.ok(
    command &&
      ['node probe.mjs', "/bin/zsh -lc 'node probe.mjs'"].includes(command),
    `Unexpected capture command: ${request.detail}`,
  );

  return { decision: 'accept' };
}

export async function nativeScenario(
  adapter: AgentAdapter,
  options: Omit<SessionOptions, 'onEvent' | 'onProcess'>,
  scenario: NativeScenario,
  report: (event: AgentEvent) => void = () => {},
  live = false,
) {
  const events: AgentEvent[] = [];

  const writeProbe = (source: string) =>
    writeFile(join(options.cwd, 'probe.mjs'), source);

  const probes = new Map<string, ProcessIdentity>();

  let nativeProcess: ProcessIdentity | undefined;

  const failures: unknown[] = [];

  let finished = false;

  const abort = new AbortController();

  let turnFailure: unknown;

  const watchTurn = (turn: Promise<TurnResult>) => {
    void turn.then(
      (result) => {
        if (result.status === 'failed')
          turnFailure = new Error(result.error ?? 'Native turn failed');
      },
      (error: unknown) => {
        turnFailure = error;
      },
    );
  };

  const waitFor = (
    what: string,
    predicate: () => boolean | Promise<boolean>,
    attempts = 150,
  ) =>
    until(
      what,
      () => {
        options.signal?.throwIfAborted();

        abort.signal.throwIfAborted();

        if (turnFailure) throw turnFailure;

        return predicate();
      },
      attempts,
    );

  const observeProbes = async () => {
    options.signal?.throwIfAborted();

    abort.signal.throwIfAborted();

    if (!nativeProcess) return;

    const rows = (await ps('pid=,ppid=,lstart=')).flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);

      return match
        ? [
            {
              pid: Number(match[1]),
              parent: Number(match[2]),
              started: match[3]!,
            },
          ]
        : [];
    });

    if (
      !sameProcess(
        rows.find((row) => row.pid === nativeProcess!.pid),
        nativeProcess,
      )
    )
      return;

    const owned = new Set([nativeProcess.pid]);

    let added = true;

    while (added) {
      added = false;

      for (const row of rows)
        if (owned.has(row.parent) && !owned.has(row.pid)) {
          owned.add(row.pid);

          added = true;
        }
    }

    owned.delete(nativeProcess.pid);

    const argumentsByPid = await processArguments([...owned]);

    for (const row of rows) {
      const args = argumentsByPid.get(row.pid);

      if (
        args &&
        basename(args[0] ?? '') === 'node' &&
        (args[1] === 'probe.mjs' || args[1] === join(options.cwd, 'probe.mjs'))
      )
        probes.set(`${row.pid}:${row.started}`, {
          pid: row.pid,
          started: row.started,
        });
    }
  };

  const probeStarted = (count: number) =>
    waitFor(
      'native probe process',
      async () => {
        await observeProbes();

        return probes.size >= count;
      },
      4500,
    );

  let session: AgentSession;

  const onEvent = (event: AgentEvent) => {
    events.push(event);

    report(event);

    if (event.type === 'request') {
      try {
        session.respond(event.request.id, probeApproval(event.request));
      } catch (error) {
        abort.abort(error);
      }
    }
  };

  const binding = {
    directory: join(options.cwd, 'control'),
    conversation: 'native-protocol',
    activation: '00000000-0000-4000-8000-000000000309',
  };

  const run = '00000000-0000-4000-8000-000000000310';

  const connect = (resume?: string) =>
    adapter.connect({
      ...options,
      signal: options.signal
        ? AbortSignal.any([options.signal, abort.signal])
        : abort.signal,
      resume,
      onEvent,
      onProcess: async (pid) => {
        if (live)
          nativeProcess =
            pid === undefined
              ? undefined
              : (await identifyProcesses([pid])).get(pid);
      },
      familiarBinding: binding,
    });

  session = await connect();

  try {
    if (scenario === 'basic') {
      assert.ok(
        (await session.models()).some(({ id }) => id === options.model),
      );

      await session.skills();

      await session.selectModel(options.model!, 'medium');

      assert.equal(session.info.model, options.model);

      assert.equal(session.info.effort, 'medium');

      const answer = await session.send(
        'Reply with only the marker in the supplied context. Do not use tools, spells or delegation.',
        { context: 'The protocol check marker is WITCH_CONTEXT_309.' },
      );

      assert.equal(answer.status, 'completed', answer.error);

      assert.equal(answer.text.trim(), 'WITCH_CONTEXT_309');

      if (adapter.id === 'codex') {
        const shell = await session.shell('printf WITCH_SHELL_309');

        assert.equal(shell.status, 'completed', shell.error);

        assert.ok(
          events.some(
            (event) =>
              event.type === 'tool' && event.text.includes('WITCH_SHELL_309'),
          ),
        );
      }

      await writeProbe(
        "import {writeFileSync} from 'node:fs'; writeFileSync('probe-result', 'WITCH_TOOL_309'); console.log('WITCH_TOOL_309');\n",
      );

      const tool = await session.send(
        adapter.id === 'codex'
          ? 'Run exactly `node probe.mjs` in this directory once, requesting native permission first if the sandbox is read-only. Do not read other files, load spells or delegate. Then reply only WITCH_TOOL_DONE_309.'
          : 'Run exactly `node probe.mjs` in this directory once. Do not read other files, load spells or delegate. Then reply only WITCH_TOOL_DONE_309.',
      );

      assert.equal(tool.status, 'completed', tool.error);

      assert.match(tool.text.trim(), /(?:^|\n)WITCH_TOOL_DONE_309$/);

      if (live)
        assert.equal(
          await readFile(join(options.cwd, 'probe-result'), 'utf8'),
          'WITCH_TOOL_309',
        );

      const compact = await session.compact();

      assert.equal(compact.status, 'completed', compact.error);

      assert.ok(events.some(({ type }) => type === 'compacted'));

      const id = session.info.id;

      await session.close();

      session = await connect(id);

      assert.equal(session.info.id, id);

      const resumed = await session.send(
        'Reply only WITCH_RESUMED_309. Do not use tools, spells or delegation.',
      );

      assert.equal(resumed.status, 'completed', resumed.error);

      assert.equal(resumed.text.trim(), 'WITCH_RESUMED_309');
    } else if (scenario === 'control') {
      await writeProbe(
        "console.log('WITCH_WAIT_309'); setTimeout(() => {}, 15000);\n",
      );

      const prompt =
        'Run exactly `node probe.mjs` in the foreground. Do not use other tools, spells or delegation. When it ends reply only WITCH_CONTROL_309.';

      const started = events.length;

      const sending = session.send(prompt);

      watchTurn(sending);

      await waitFor(
        'native tool start',
        () =>
          events
            .slice(started)
            .some((event) => event.type === 'tool' && !event.done),
        4500,
      );

      if (live) await probeStarted(1);

      assert.equal(
        await session.steer('Also include STEER_309 in the final reply.'),
        true,
      );

      const steered = await within(sending, 120000, 'steered native turn');

      assert.equal(steered.status, 'completed', steered.error);

      assert.match(steered.text, /STEER_309/);

      const before = events.length;

      const interrupted = session.send(prompt);

      watchTurn(interrupted);

      await waitFor(
        'interrupt tool start',
        () =>
          events
            .slice(before)
            .some((event) => event.type === 'tool' && !event.done),
        4500,
      );

      if (live) await probeStarted(2);

      await session.interrupt();

      assert.equal((await interrupted).status, 'interrupted');
    } else if (scenario === 'spell') {
      const skills = await session.skills();

      const cast = (from: number) =>
        events
          .slice(from)
          .some(
            (event) =>
              event.type === 'spell' && event.cast.name === 'probe-spell',
          );

      let from = events.length;

      const agent = await session.send(
        'Run the probe spell with argument hi. Do not use a subagent.',
      );

      assert.equal(agent.status, 'completed', agent.error);

      assert.match(agent.text, /PROBE CAST hi/);

      assert.ok(cast(from), 'the agent casts the probe spell');

      from = events.length;

      const familiar = await session.send(
        'Launch exactly one subagent. Its task: run the probe spell with argument fam and report what it said. Wait for it, then repeat its report.',
      );

      assert.equal(familiar.status, 'completed', familiar.error);

      assert.ok(
        events
          .slice(from)
          .some(
            (event) =>
              event.type === 'subagent' &&
              event.subagent.spells?.some(({ name }) => name === 'probe-spell'),
          ),
        'a familiar casts the probe spell',
      );

      from = events.length;

      const prompt = '/probe-spell hello';

      const call = skillCall(prompt, skills);

      assert.ok(call, 'the probe spell is listed');

      const user = await session.send(prompt, { skill: call });

      assert.equal(user.status, 'completed', user.error);

      assert.match(user.text, /PROBE CAST hello/);

      assert.ok(cast(from), 'the user casts the probe spell');
    } else if (scenario === 'idle-run') {
      // the second run, started by Claude Code after the brew ends, sleeps so a prompt lands inside it
      await writeProbe(
        "import {existsSync} from 'node:fs'; if (existsSync('emit')) setTimeout(() => console.log('WITCH_SLOW_505'), 8000); else { const timer = setInterval(() => { if (existsSync('emit')) { clearInterval(timer); console.log('WITCH_DONE_505'); } }, 20); }\n",
      );

      const started = await session.send(
        'Run exactly `node probe.mjs` with Bash run_in_background=true. Do not read files, load spells or delegate. Reply only WITCH_BACKGROUND_505 after starting it. When it finishes, run exactly `node probe.mjs` once more in the foreground, then reply only WITCH_NATIVE_505.',
      );

      assert.equal(started.status, 'completed', started.error);

      await waitFor(
        'native background membership',
        () =>
          events.some(
            (event) =>
              event.type === 'command' && event.command.status === 'running',
          ),
        1500,
      );

      if (live) await probeStarted(1);

      const from = events.length;

      await writeFile(join(options.cwd, 'emit'), 'emit');

      // the approval comes from the run Claude Code starts once the brew ends, and is answered as it arrives, so the
      // prompt follows it on the wire
      await waitFor(
        'native tool approval',
        () => events.slice(from).some((event) => event.type === 'request'),
        3000,
      );

      // Claude Code takes the prompt into its own run at the next tool boundary, and that run's result names it
      if (live) await probeStarted(2);

      const prompted = await session.send(
        'Reply only WITCH_PROMPT_505. Do not use tools, spells or delegation.',
      );

      assert.equal(prompted.status, 'completed', prompted.error);

      assert.equal(prompted.text.trim(), 'WITCH_PROMPT_505');

      await waitFor(
        'native idle',
        () =>
          events.findLast((event) => event.type === 'running')?.running ===
          false,
        3000,
      );
    } else {
      await writeProbe(
        `import {existsSync} from 'node:fs'; const timer = setInterval(() => { if (existsSync('emit')) { process.stdout.write(${JSON.stringify(familiarMarker({ version: 1, conversation: binding.conversation, activation: binding.activation, run }))}); clearInterval(timer); } }, 20); setTimeout(() => {}, 120000);\n`,
      );

      const result = await session.send(
        adapter.id === 'claude'
          ? 'Run exactly `node probe.mjs` with Bash run_in_background=true. Do not read files, load spells or delegate. Reply only WITCH_BACKGROUND_309 after starting it. Do not wait for it or stop it.'
          : 'Run exactly `node probe.mjs` with exec_command yield_time_ms=1000. Request native permission if needed. Do not read files, load spells or delegate. Reply only WITCH_BACKGROUND_309 after starting it. Do not wait for it or stop it.',
      );

      assert.equal(result.status, 'completed', result.error);

      assert.match(result.text, /WITCH_BACKGROUND_309/);

      await waitFor(
        'native background membership',
        () =>
          events.some(
            (event) =>
              event.type === 'command' && event.command.status === 'running',
          ),
        1500,
      );

      if (live) await probeStarted(1);

      await writeFile(join(options.cwd, 'emit'), 'emit');

      await waitFor(
        'native output marker',
        async () =>
          (
            await session.familiar!.report(
              {
                kind: 'familiar-register',
                run,
                name: 'protocol probe',
                runtime: 'codex',
              },
              Date.now() + 10000,
            )
          ).kind === 'familiar-registered',
        100,
      );

      assert.ok(
        events.some(
          (event) =>
            event.type === 'subagent' &&
            event.subagent.name === 'protocol probe',
        ),
      );

      await session.familiar!.report(
        {
          kind: 'familiar-update',
          run,
          sequence: 1,
          progress: { status: 'completed', report: 'WITCH_BACKGROUND_309' },
        },
        Date.now() + 10000,
      );

      assert.ok(
        events.some(
          (event) =>
            event.type === 'subagent' &&
            event.subagent.status === 'completed' &&
            event.subagent.report === 'WITCH_BACKGROUND_309',
        ),
      );
    }

    finished = true;
  } catch (error) {
    // a failed approval aborts the session, so the turn's own failure only says it was aborted
    failures.push(abort.signal.aborted ? abort.signal.reason : error);
  } finally {
    try {
      await session.close();
    } catch (error) {
      failures.push(error);
    }

    if (live) {
      try {
        if (
          finished &&
          ['control', 'background', 'idle-run'].includes(scenario)
        )
          assert.ok(
            probes.size > 0,
            'Native probe process identity was not observed',
          );

        if (probes.size) await confirmProbeExit([...probes.values()]);
      } catch (error) {
        failures.push(error);
      }
    }
  }

  if (failures.length === 1) throw failures[0];

  if (failures.length)
    throw new AggregateError(failures, failures.map(errorMessage).join('\n'));

  return events;
}

async function within(
  promise: Promise<TurnResult>,
  milliseconds: number,
  what: string,
): Promise<TurnResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${what} timed out`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function until(
  what: string,
  predicate: () => boolean | Promise<boolean>,
  attempts = 150,
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await predicate()) return;

    await delay(20);
  }

  throw new Error(`Timed out waiting for ${what}`);
}

async function confirmProbeExit(processes: ProcessIdentity[]): Promise<void> {
  const remaining = async () => {
    const actual = await identifyProcesses(
      processes.map((identity) => identity.pid),
    );

    return processes.filter((identity) =>
      sameProcess(actual.get(identity.pid), identity),
    );
  };

  for (let attempt = 0; attempt < 100; attempt++) {
    if (!(await remaining()).length) return;

    await delay(20);
  }

  const leaked = await remaining();

  for (const identity of leaked) {
    if (
      !sameProcess(
        (await identifyProcesses([identity.pid])).get(identity.pid),
        identity,
      )
    )
      continue;

    try {
      process.kill(identity.pid, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }

  await until('probe process cleanup', async () => !(await remaining()).length);

  assert.equal(
    leaked.length,
    0,
    `Native cleanup left probe processes running: ${leaked.map((identity) => identity.pid).join(', ')}`,
  );
}
