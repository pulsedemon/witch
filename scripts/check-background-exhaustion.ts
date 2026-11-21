import { execFile, spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, renameSync, writeFileSync } from 'node:fs';
import { lstat, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { installedAgents } from '../src/agents/registry.js';
import type { AgentRegistration } from '../src/agents/registry.js';
import { nativeLaunch } from '../src/agents/native-launch.js';
import { beforeDeadline } from '../src/agents/shutdown.js';
import { shellWords } from '../src/agents/tool-title.js';
import { verificationAdapter } from '../src/agents/updates/native-verification-profile.js';
import type { NativeRuntime } from '../src/agents/updates/runtime-updates.js';
import type { VerificationLaunch } from '../src/agents/updates/native-verification-profile.js';
import { controlPrefix } from '../src/cli/cli-control.js';
import { SessionCoordination } from '../src/core/coordination/coordination.js';
import { Coordinator } from '../src/core/coordinator.js';
import type { Snapshot } from '../src/core/snapshot.js';
import { JobWatch } from '../src/core/jobs/jobs.js';
import {
  comparable,
  resolve as resolveModel,
} from '../src/core/runtime/routing.js';
import { router } from '../src/core/runtime/router.js';
import {
  creditCapacity,
  headroom,
  limitsFor,
  over,
} from '../src/core/runtime/usage.js';
import type { ProcessIdentity } from '../src/core/state.js';
import { Memory } from '../src/memory/memory.js';
import { callControl } from '../src/persistence/control.js';
import type { ControlBinding } from '../src/persistence/control.js';
import { DelegationStore } from '../src/persistence/delegation.js';
import { unlessGone, writeJson } from '../src/persistence/json.js';
import {
  identifyProcess,
  runs,
  stopLeftProcesses,
} from '../src/persistence/process.js';
import { StateStore } from '../src/persistence/store.js';
import { quote } from '../src/shell.js';
import { normalizeWire, observeWire } from '../test/fixtures/native-wire.js';
import { EvidenceJournal, field, object } from './background-exhaustion.js';
import type {
  AcceptanceResult,
  Expectation,
  Status,
} from './background-exhaustion.js';

const execute = promisify(execFile);
const entry = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const caseBudget = 5 * 60_000;

class CheckStopped extends Error {
  constructor(
    readonly status: Exclude<Status, 'passed'>,
    readonly reason: string,
  ) {
    super(reason);
  }
}

interface CaseOptions {
  directory: string;
  sourceModel: string;
  refusalModel: string;
  withBrew: boolean;
  signal: AbortSignal;
}

interface Familiar {
  name: string;
  command: string;
  report: string;
  tokenHelper: string;
}

function checkStaging(
  snapshot: Pick<Snapshot, 'requests' | 'error'> | undefined,
  signal: AbortSignal,
): void {
  if (snapshot?.error) throw new CheckStopped('failed', 'coordinator-error');

  if (snapshot?.requests.length)
    throw new CheckStopped('blocked', 'native-permission-required');

  signal.throwIfAborted();
}

async function readRecord(
  filename: string,
): Promise<Record<string, unknown> | undefined> {
  const contents = await unlessGone(readFile(filename, 'utf8'));

  return contents === undefined ? undefined : object(JSON.parse(contents));
}

export async function waitForEvidenceFile(
  filename: string,
  snapshot: () => Pick<Snapshot, 'requests' | 'error'> | undefined,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  for (;;) {
    checkStaging(snapshot(), signal);
    const contents = await readRecord(filename);
    checkStaging(snapshot(), signal);

    if (contents !== undefined) return contents;

    await delay(50, undefined, { signal });
  }
}

export const scenarioHelper = `
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
const name = process.argv[2];
const identity = pid => ({ pid, started: execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
  encoding: 'utf8', env: { ...process.env, LC_ALL: process.platform === 'linux' ? 'C.UTF-8' : undefined,
    LC_TIME: 'C', LC_NUMERIC: 'C', TZ: 'UTC' },
}).trim() });
const publish = (file, value) => {
  writeFileSync(file + '.tmp', JSON.stringify(value), { mode: 0o600 });
  renameSync(file + '.tmp', file);
};
publish(name + '.ready.json', identity(process.pid));
const end = Date.now() + 240000;
const wait = async file => {
  while (!existsSync(file)) {
    if (Date.now() >= end) throw Error('Unreleased check gate: ' + file);
    await delay(50);
  }
};
if (name.startsWith('token-')) {
  await wait('token.json');
  await wait('familiars.release');
  console.log(JSON.parse(readFileSync('token.json')).value);
} else if (name === 'trigger' || name === 'budget') {
  await wait('trigger.release');
  if (name === 'budget') await delay(15000);
  publish(name + '.done.json', { code: 0, natural: true });
} else {
  const { command, prompt, env } = JSON.parse(readFileSync(name + '.launch.json'));
  const child = spawn(command[0], command.slice(1), {
    stdio: ['pipe', 'inherit', 'inherit'], env: { ...process.env, ...env },
  });
  publish(name + '.child.json', identity(child.pid));
  child.stdin.end(prompt);
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  publish(name + '.exit.json', result);
  process.exitCode = result.code ?? 1;
}
`;

export async function releaseTrigger(
  coordinator: Pick<Coordinator, 'selectModel' | 'snapshot'>,
  model: string,
  project: string,
  journal: EvidenceJournal,
  deadline: number,
): Promise<void> {
  try {
    await beforeDeadline(
      coordinator.selectModel({ agent: 'claude', id: model }),
      deadline,
    );
  } catch (error) {
    journal.fact('model-change-error', String(error));

    throw new CheckStopped('blocked', 'native-model-change-refused');
  }

  const native = coordinator.snapshot.native?.model;
  const persisted = coordinator.snapshot.conversation?.sessions.claude?.model;
  journal.fact('selected', { model: native, persisted });

  if (native !== model || persisted !== model)
    throw new CheckStopped('failed', 'native-model-selection-disagrees');

  journal.fact('trigger', true);
  await writeFile(join(project, 'trigger.release'), 'release');
}

export async function checkCapacity(
  agents: readonly AgentRegistration[],
  {
    sourceModel,
    refusalModel,
    signal,
  }: Pick<CaseOptions, 'sourceModel' | 'refusalModel' | 'signal'>,
  project: string,
  journal: EvidenceJournal,
): Promise<void> {
  const discovery = agents.map(async ({ adapter, executable }) => {
    const settings = { executable: executable!, cwd: project, signal };

    const [models, account, latest] = await Promise.all([
      adapter.models(settings),
      adapter.accountUsage(settings, { limits: [] }),
      adapter.latest?.(settings) ?? {},
    ]);

    return {
      runtime: adapter.id,
      models,
      account,
      latest,
    };
  });

  const available = await Promise.all(discovery);
  journal.fact('discovery', available);
  const source = available.find((value) => value.runtime === 'claude')!;
  const destination = available.find((value) => value.runtime === 'codex')!;

  const listed = new Set([
    ...source.models.map((model) => model.id),
    ...Object.values(source.latest),
  ]);

  if (!listed.has(sourceModel) || !listed.has(refusalModel))
    throw new CheckStopped('blocked', 'source-model-not-listed');

  const now = Date.now();

  if (
    !headroom(limitsFor(source.account, sourceModel), 100, now) &&
    creditCapacity(source.account, now) !== 'available'
  )
    throw new CheckStopped('blocked', 'source-setup-capacity-unavailable');

  if (
    !over(limitsFor(source.account, refusalModel), 100, now) ||
    creditCapacity(source.account, now) === 'available'
  )
    throw new CheckStopped('blocked', 'refusal-not-currently-stageable');

  const family = comparable('claude', refusalModel, 'codex');

  const chosen =
    family &&
    resolveModel('codex', family, {
      models: destination.models.map((model) => ({
        ...model,
        agent: 'codex',
      })),
      latest: {},
    });

  if (!chosen || !('model' in chosen))
    throw new CheckStopped('blocked', 'destination-model-unavailable');

  if (
    !headroom(limitsFor(destination.account, chosen.model), 100, now) &&
    creditCapacity(destination.account, now) !== 'available'
  )
    throw new CheckStopped('blocked', 'destination-capacity-unavailable');

  journal.fact('destination-model', chosen.model);
}

export async function runCase(
  options: CaseOptions,
  registrations: readonly AgentRegistration[],
  fixtureLaunch?: VerificationLaunch,
): Promise<
  AcceptanceResult & {
    evidence: 'native' | 'offline';
    unverifiedProcesses: { pid: number; started?: string }[];
  }
> {
  const { directory, sourceModel, refusalModel, withBrew } = options;
  const project = join(directory, 'project');
  await mkdir(project, { recursive: true, mode: 0o700 });

  const journal = new EvidenceJournal((row) =>
    appendFileSync(
      join(directory, 'events.jsonl'),
      JSON.stringify(row) + '\n',
      { mode: 0o600 },
    ),
  );

  const expected: Expectation = {
    marker: 'BACKGROUND_SETUP_' + randomUUID(),
    queued: 'Reply only QUEUED_DONE. Queue marker: ' + randomUUID(),
    reply: 'QUEUED_DONE',
    refusalModel,
    withBrew,
  };

  const signal = AbortSignal.any([
    options.signal,
    AbortSignal.timeout(caseBudget),
  ]);

  const caseDeadline = performance.now() + caseBudget;
  let state: StateStore | undefined;
  let coordinator: Coordinator | undefined;
  let binding: ControlBinding | undefined;
  let coordination: SessionCoordination | undefined;
  let jobs: JobWatch | undefined;
  let unsubscribe: (() => void) | undefined;
  let problem: CheckStopped | undefined;
  const pending: Promise<unknown>[] = [];

  const processes: {
    child: ChildProcessWithoutNullStreams;
    capture: ReturnType<typeof observeWire>;
    identity?: ProcessIdentity;
    runtime: NativeRuntime;
  }[] = [];

  const helpers = new Map<string, ProcessIdentity>();
  const familiars: Familiar[] = [];
  const cleanupErrors: unknown[] = [];
  const unverifiedProcesses: { pid: number; started?: string }[] = [];
  let token = '';
  let codexOptions: string[] = [];

  const track = (operation: Promise<unknown>) => {
    pending.push(operation);

    void operation.catch((error: unknown) => {
      journal.fact('error', String(error));
      problem ??= new CheckStopped('failed', 'pending-operation-failed');
      journal.fact('pending-failure', true);
    });
  };

  const staging = () => {
    if (problem) throw problem;

    return coordinator?.snapshot;
  };

  const wait = (label: string, predicate: () => boolean) =>
    journal.waitFor(
      label,
      () => {
        checkStaging(staging(), signal);

        return predicate();
      },
      signal,
    );

  const bounded = <T>(operation: Promise<T>) =>
    beforeDeadline(operation, caseDeadline);

  const read = (name: string) => readRecord(join(project, name));

  const file = (name: string) =>
    waitForEvidenceFile(join(project, name), staging, signal);

  const liveHelper = async (name: string) => {
    const data = await file(name + '.ready.json');

    if (typeof data.pid !== 'number' || typeof data.started !== 'string')
      throw new CheckStopped('failed', 'helper-identity-invalid');

    const identity = { pid: data.pid, started: data.started };
    helpers.set(name, identity);

    if (!(await runs(identity)))
      throw new CheckStopped('incomplete', 'helper-already-ended');

    journal.fact('helper-running', { name, identity });
  };

  const claimState = async () => {
    if (!binding)
      throw new CheckStopped('incomplete', 'scratch-claim-not-bound');

    const outcome = await callControl(binding, { kind: 'peers' });

    if (outcome.kind !== 'peers' || !outcome.snapshot.ownClaim)
      throw new CheckStopped('failed', 'scratch-claim-not-retained');

    const { id, references } = outcome.snapshot.ownClaim;

    return {
      conversation: coordinator!.snapshot.conversation!.id,
      id,
      references,
    };
  };

  try {
    const agents: AgentRegistration[] = [];

    for (const runtime of ['claude', 'codex'] as const) {
      const registration = registrations.find(
        (value) => value.adapter.id === runtime,
      );

      if (!registration?.executable)
        throw new CheckStopped('blocked', `${runtime}-not-installed`);

      const profile = join(directory, runtime);
      await mkdir(profile, { mode: 0o700 });

      const adapter = await verificationAdapter(runtime, profile, {
        start: (command, args, cwd, env, launchSignal) => {
          if (runtime === 'codex') codexOptions = args.slice(2);

          const child = fixtureLaunch
            ? fixtureLaunch(command, args, cwd, env, launchSignal)
            : nativeLaunch(command, env, (executable) =>
                spawn(executable, args, {
                  cwd,
                  env,
                  signal: launchSignal,
                  stdio: 'pipe',
                }),
              );

          const capture = observeWire(child, (frame) => {
            journal.record({
              kind: 'wire',
              runtime,
              process: child.pid ?? 0,
              frame,
            });

            const accepted = journal.accepted(expected.marker);

            if (runtime === 'claude' && accepted && !token) {
              token = randomUUID();

              writeFileSync(
                join(project, 'token.tmp'),
                JSON.stringify({ value: token }),
                { mode: 0o600, flag: 'wx' },
              );

              renameSync(
                join(project, 'token.tmp'),
                join(project, 'token.json'),
              );

              journal.fact('token', { value: token });
            }
          });

          const recorded = {
            child,
            capture,
            runtime,
            identity: undefined as ProcessIdentity | undefined,
          };

          processes.push(recorded);

          track(
            identifyProcess(child.pid!).then((identity) => {
              recorded.identity = identity;
            }),
          );

          return child;
        },
      });

      const connect = adapter.connect.bind(adapter);

      adapter.connect = async (settings) => {
        let sessionId = '';

        const session = await connect({
          ...settings,
          signal: AbortSignal.any([
            signal,
            ...(settings.signal ? [settings.signal] : []),
          ]),
          onEvent: (event) => {
            if (event.type === 'info') sessionId = event.info.id;

            journal.record({
              kind: 'event',
              runtime,
              session: sessionId,
              event,
            });

            settings.onEvent(event);

            if (
              runtime === 'claude' &&
              event.type === 'exhausted' &&
              !journal.facts('queued').length
            ) {
              journal.fact('queued', true);
              track(coordinator!.send(expected.queued));
            }
          },
        });

        sessionId = session.info.id;
        const send = session.send.bind(session);

        session.send = async (prompt, sendOptions) => {
          journal.fact('send', {
            runtime,
            prompt,
            context: sendOptions?.context,
          });

          if (runtime === 'codex' && prompt.startsWith('Continue the task')) {
            const records = await state!.records([
              coordinator!.snapshot.conversation!.id,
            ]);

            journal.fact('admission', {
              ...(await claimState()),
              sourceOutcome: records.records[0]?.lastTurn?.status,
            });
          }

          const result = send(prompt, sendOptions);

          void result.then(
            (value) => journal.fact('send-result', { runtime, ...value }),
            () => {},
          );

          return result;
        };

        return session;
      };

      agents.push({ adapter, executable: registration.executable });
    }

    await bounded(
      checkCapacity(agents, { ...options, signal }, project, journal),
    );

    await execute('git', ['init', '-b', 'main'], { cwd: project, signal });
    await writeFile(join(project, 'helper.mjs'), scenarioHelper);

    const instructions =
      'This is a disposable native background-exhaustion check. Perform only its exact synthetic instructions. Do not edit memory, read credentials, use connected tools, load spells or delegate beyond the supplied Witch commands.\n';

    await writeFile(join(project, 'CLAUDE.md'), instructions);
    await writeFile(join(project, 'AGENTS.md'), instructions);
    state = await StateStore.open(join(directory, 'state'));
    const memory = new Memory(join(directory, 'state', 'memory.git'));

    coordination = await SessionCoordination.open(
      state,
      memory,
      join(directory, 'control'),
      (binding) => controlPrefix(binding, entry),
    );

    jobs = new JobWatch({ directory: join(directory, 'jobs'), interval: 100 });

    coordinator = new Coordinator(
      state,
      memory,
      agents,
      jobs,
      undefined,
      coordination,
    );

    coordination.router = router(
      coordinator,
      await DelegationStore.open(join(directory, 'state', 'delegation')),
      (deadline) => coordination!.routingDemand(deadline),
    );

    unsubscribe = coordinator.subscribe(() => {
      const snapshot = coordinator!.snapshot;

      journal.fact('snapshot', {
        phase: snapshot.phase,
        conversation: snapshot.conversation,
        native: snapshot.native,
        nativeRunning: snapshot.nativeRunning,
        queue: snapshot.queue,
        requests: snapshot.requests,
        subagents: snapshot.subagents,
        backgroundCommands: snapshot.backgroundCommands,
        commandsPending: snapshot.commandsPending,
        pendingCompaction: snapshot.pendingCompaction,
        error: snapshot.error,
      });
    });

    await bounded(coordinator.initialize(project));

    await bounded(
      coordinator.selectModel({ agent: 'claude', id: sourceModel }),
    );

    const scope = await memory.scopePaths(project);

    binding = await coordination.activate(
      coordinator.snapshot.conversation!,
      scope.project,
    );

    const claim = await callControl(binding, {
      kind: 'claim',
      input: {
        reference:
          'task:background-exhaustion-' + (withBrew ? 'with-brew' : 'no-brew'),
        summary:
          'Run the authorized isolated background-exhaustion acceptance check',
        aliases: [],
      },
    });

    if (claim.kind !== 'claimed')
      throw new CheckStopped('blocked', 'scratch-claim-refused');

    journal.fact('claim-before', await claimState());

    const route = await callControl(binding, {
      kind: 'route',
      work: 'investigation',
    });

    journal.fact('route', route);

    if (route.kind !== 'route' || !route.routes.length)
      throw new CheckStopped('blocked', 'familiar-route-unavailable');

    const prefix = shellWords(coordination.commandPrefixes().familiar);

    if (!prefix || prefix.rest.trim())
      throw new CheckStopped('failed', 'invalid-familiar-prefix');

    for (const [index, placement] of route.routes.entries()) {
      const name = `familiar-${index}`;
      const report = join(project, name + '.report.txt');

      const command = [process.execPath, join(project, 'helper.mjs'), name]
        .map(quote)
        .join(' ');

      const tokenHelper = `token-${index}`;

      const gate = [process.execPath, join(project, 'helper.mjs'), tokenHelper]
        .map(quote)
        .join(' ');

      const args =
        placement.runtime === 'codex'
          ? [
              '--without-mcp',
              '--',
              ...codexOptions,
              '-c',
              `model=${JSON.stringify(placement.model)}`,
              '-c',
              'model_reasoning_effort="low"',
            ]
          : [
              '--',
              '--model',
              placement.model,
              '--effort',
              'low',
              '--restricted',
              '--safe-mode',
              '--strict-mcp-config',
              '--mcp-config',
              '{"mcpServers":{}}',
              '--tools',
              'Read,Bash',
              '--permission-prompts',
              'none',
              '--no-session-persistence',
            ];

      await writeJson(join(project, name + '.launch.json'), {
        env: { CODEX_HOME: join(directory, 'codex', 'config') },
        command: [
          ...prefix.words,
          '--familiar-' + placement.runtime,
          name,
          '--report-file',
          report,
          ...args,
        ],
        prompt: `Run exactly this authorized synthetic command once and wait for it to finish: ${gate}\nOn Codex use exec_command with sandbox_permissions require_escalated because its identity check uses /bin/ps. Its stdout is an independently generated token. Reply only with that token. Do not delegate, edit files, release gates or do other work.`,
      });

      familiars.push({ name, report, command, tokenHelper });
    }

    const command = (name: string) =>
      [process.execPath, join(project, 'helper.mjs'), name]
        .map(quote)
        .join(' ');

    const commands = [
      ...familiars.map((familiar) => familiar.command),
      command('trigger'),
      ...(withBrew ? [command('budget')] : []),
    ];

    const prompt = `${expected.marker}\nThis isolated acceptance check is authorized. Run each exact command below once in a separate Bash call with run_in_background true, without waiting for completion, then reply SETUP_DONE. Do not release gates, change models or do other work. Do not edit memory.\n${commands.join('\n')}\nThe task remains unfinished until the trigger completes. On familiar completion, acknowledge its token without tools. When Witch resumes this unfinished task after the trigger, reply CONTINUED followed by the completed familiar report's token, using only supplied context and no tools. A later separately queued request is answered separately.`;

    journal.fact('original', {
      prompt,
      commands,
      launches: await Promise.all(
        familiars.map((familiar) => read(familiar.name + '.launch.json')),
      ),
    });

    track(coordinator.send(prompt));

    await wait(
      'ordinary input/result/acknowledgements/idle',
      () => !!journal.ordinary(expected.marker),
    );

    await liveHelper('trigger');

    if (withBrew) {
      await liveHelper('budget');

      journal.fact('budget-ready', {
        command: command('budget'),
        identity: helpers.get('budget'),
      });
    }

    for (const familiar of familiars) await liveHelper(familiar.name);

    await writeFile(join(project, 'familiars.release'), 'release');

    for (const familiar of familiars) {
      const exit = await file(familiar.name + '.exit.json');
      const contents = await readFile(familiar.report, 'utf8');

      const row = coordinator.snapshot.subagents.find(
        (value) => value.name === familiar.name,
      );

      if (
        exit.code !== 0 ||
        exit.signal !== null ||
        !row?.run ||
        row.status !== 'completed' ||
        !contents.includes(token)
      )
        throw new CheckStopped('failed', 'familiar-report-failed');

      journal.fact('report', {
        name: familiar.name,
        run: row.run,
        command: familiar.command,
        text: contents,
        ...exit,
      });

      const task = journal.task(familiar.command);

      if (!task)
        throw new CheckStopped(
          'incomplete',
          'native-familiar-task-not-identified',
        );

      const completed = journal.entries.find(
        (entry) =>
          entry.kind === 'event' &&
          entry.event.type === 'subagent' &&
          entry.event.subagent.run === row.run &&
          entry.event.subagent.status === 'completed',
      )!;

      await wait(
        'familiar notification follow-up result and idle',
        () => !!journal.followup(task, completed.sequence),
      );
    }

    await releaseTrigger(
      coordinator,
      refusalModel,
      project,
      journal,
      caseDeadline,
    );

    await wait('structured background exhaustion', () =>
      journal.entries.some(
        (row) =>
          row.kind === 'event' &&
          row.runtime === 'claude' &&
          row.event.type === 'exhausted',
      ),
    );

    if (withBrew) {
      if (!(await runs(helpers.get('budget')!)))
        throw new CheckStopped(
          'incomplete',
          'budget-brew-not-live-at-exhaustion',
        );

      if (
        coordinator.snapshot.conversation?.agent !== 'claude' ||
        !coordinator.snapshot.queue.includes(expected.queued)
      )
        throw new CheckStopped('failed', 'budget-brew-did-not-hold-switch');

      journal.fact('brew-held', true);
      const done = await file('budget.done.json');

      if (done.code !== 0 || done.natural !== true)
        throw new CheckStopped('failed', 'budget-brew-did-not-complete');

      journal.fact('budget-done', done);
    }

    const exhaustion = journal.entries.find(
      (entry) => entry.kind === 'event' && entry.event.type === 'exhausted',
    )!;

    await wait(
      'source native work and commands settled',
      () => !!journal.settlement(exhaustion.sequence),
    );

    await wait('destination continuation and queued response', () => {
      const result = journal.finish(expected);

      return result.conditions
        .filter(
          (condition) =>
            condition.name.startsWith('acknowledged native') ||
            condition.name.startsWith('queued prompt'),
        )
        .every((condition) => condition.status === 'verified');
    });

    await wait(
      'destination idle',
      () =>
        coordinator!.snapshot.phase === 'idle' &&
        !coordinator!.snapshot.nativeRunning &&
        !coordinator!.snapshot.queue.length,
    );

    journal.fact('claim-after', await claimState());
  } catch (error) {
    journal.fact('error', error instanceof Error ? error.stack : String(error));

    journal.fact('stop', {
      status: error instanceof CheckStopped ? error.status : 'incomplete',
      reason:
        error instanceof CheckStopped
          ? error.reason
          : 'execution-interrupted-or-barrier-unverified',
    });
  } finally {
    const deadline = performance.now() + 30_000;

    const clean = async (
      action: () => Promise<unknown>,
      identity?: { pid: number; started?: string },
    ) => {
      try {
        await beforeDeadline(action(), deadline);
      } catch (error) {
        cleanupErrors.push(String(error));

        if (identity) unverifiedProcesses.push(identity);
      }
    };

    await clean(async () => {
      await coordinator?.interrupt({ deadline });
    });

    await clean(async () => {
      if (jobs)
        for (const job of await jobs.list()) await clean(() => jobs!.stop(job));
    });

    for (const name of [
      ...familiars.map((familiar) => familiar.name),
      'trigger',
      'budget',
      ...familiars.map((familiar) => familiar.tokenHelper),
    ]) {
      for (const suffix of ['.ready.json', '.child.json']) {
        await clean(async () => {
          const identity = await read(name + suffix);

          if (
            typeof identity?.pid === 'number' &&
            typeof identity.started === 'string'
          ) {
            const owned = { pid: identity.pid, started: identity.started };
            await clean(() => stopLeftProcesses({ process: owned }), owned);
          }
        });
      }
    }

    await clean(async () => {
      await coordinator?.close();
    });

    await clean(async () => {
      await coordination?.close();
    });

    unsubscribe?.();
    jobs?.close();

    for (const process of processes) {
      await clean(
        async () => {
          if (process.identity && (await runs(process.identity)))
            await stopLeftProcesses({ process: process.identity });

          await process.capture.finished().catch((error: unknown) => {
            journal.fact('capture-error', String(error));

            if (!journal.facts('stop').length)
              journal.fact('stop', {
                status: 'incomplete',
                reason: 'native-capture-incomplete',
              });
          });

          await writeJson(
            join(
              directory,
              `${process.runtime}-${process.child.pid}-normalized.json`,
            ),
            normalizeWire(process.capture.frames, directory, homedir()),
          );
        },
        { pid: process.child.pid ?? 0, started: process.identity?.started },
      );
    }

    await clean(() => Promise.allSettled(pending));

    await clean(async () => {
      const auth = join(directory, 'codex', 'config', 'auth.json');

      if ((await unlessGone(lstat(auth)))?.isSymbolicLink()) await unlink(auth);
    });

    journal.fact('cleanup-errors', cleanupErrors);
    journal.fact('cleanup', cleanupErrors.length === 0);
  }

  const result = {
    ...journal.finish(expected),
    evidence: fixtureLaunch ? ('offline' as const) : ('native' as const),
    unverifiedProcesses,
  };

  await writeJson(join(directory, 'result.json'), result);

  return result;
}

export async function main(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      out: { type: 'string' },
      'source-model': { type: 'string' },
      'refusal-model': { type: 'string' },
      'allow-account-usage': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });

  if (values.help) {
    console.log(
      'Usage: node --import tsx scripts/check-background-exhaustion.ts --out <new-directory> --source-model <id> --refusal-model <id> --allow-account-usage\nExit 0: both native cases passed. Exit 2: staging blocked. Exit 1: failed or incomplete. Evidence remains private in --out.',
    );

    return 0;
  }

  if (!values.out) throw new Error('--out is required');

  const directory = resolve(values.out);

  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (field(error, 'code') !== 'EEXIST') throw error;

    console.error('Output directory already exists; nothing was overwritten.');

    return 2;
  }

  if (
    !values['allow-account-usage'] ||
    !values['source-model'] ||
    !values['refusal-model']
  ) {
    await writeJson(join(directory, 'result.json'), {
      status: 'blocked',
      reason: !values['allow-account-usage']
        ? 'account-usage-consent-required'
        : 'explicit-models-required',
      cleanup: 'verified',
      cases: [],
    });

    console.log(
      'Blocked before native launch. See result.json in the output directory.',
    );

    return 2;
  }

  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error('Interrupted'));
  let metadata: unknown;

  const cases: (AcceptanceResult & {
    name: string;
    evidence: 'native' | 'offline';
  })[] = [];

  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);

  try {
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(15 * 60_000),
    ]);

    const registrations = await installedAgents();

    const versions = await Promise.all(
      registrations.map(async ({ adapter, executable }) => ({
        runtime: adapter.id,
        version: executable
          ? (await execute(executable, ['--version'], { signal })).stdout.trim()
          : 'not-installed',
      })),
    );

    const sdk = object(
      JSON.parse(
        await readFile(
          new URL(
            '../node_modules/@anthropic-ai/claude-agent-sdk/package.json',
            import.meta.url,
          ),
          'utf8',
        ),
      ),
    ).version;

    const revision = (
      await execute('git', ['rev-parse', 'HEAD'], { signal })
    ).stdout.trim();

    const dirty = !!(
      await execute('git', ['status', '--porcelain'], { signal })
    ).stdout.trim();

    metadata = {
      revision,
      dirty,
      node: process.version,
      sdk,
      versions,
      sourceModel: values['source-model'],
      refusalModel: values['refusal-model'],
    };

    for (const withBrew of [false, true]) {
      signal.throwIfAborted();
      const name = withBrew ? 'with-brew' : 'no-brew';
      console.log('Checking ' + name);

      const result = await runCase(
        {
          directory: join(directory, name),
          sourceModel: values['source-model'],
          refusalModel: values['refusal-model'],
          withBrew,
          signal,
        },
        registrations,
      );

      cases.push({ name, ...result });
      console.log(`${name}: ${result.status} (${result.reason})`);

      if (result.status !== 'passed') break;
    }

    const status =
      cases.length === 2 && cases.every((value) => value.status === 'passed')
        ? 'passed'
        : cases.some(
              (value) =>
                value.status === 'failed' || value.status === 'incomplete',
            )
          ? 'incomplete'
          : 'blocked';

    await writeJson(join(directory, 'result.json'), {
      status,
      metadata,
      cases,
      unrun: cases.length === 1 ? ['with-brew'] : [],
    });

    return status === 'passed' ? 0 : status === 'blocked' ? 2 : 1;
  } catch (error) {
    appendFileSync(join(directory, 'failure.txt'), String(error), {
      mode: 0o600,
    });

    await writeJson(join(directory, 'result.json'), {
      status: 'incomplete',
      reason: 'preflight-or-execution-interrupted',
      metadata,
      cases,
      unrun: ['no-brew', 'with-brew'].filter(
        (name) => !cases.some((entry) => entry.name === name),
      ),
    });

    return 1;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  process.exitCode = await main(process.argv.slice(2));
