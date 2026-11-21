import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { appendFileSync, realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createElement } from 'react';
import { render } from 'ink';
import { CodexAdapter } from '../src/agents/codex/adapter.js';
import { scanMarkers } from '../src/agents/familiar-report.js';
import type { MarkerLine } from '../src/agents/familiar-report.js';
import { installedAgents } from '../src/agents/registry.js';
import { shellWords } from '../src/agents/tool-title.js';
import type { Subagent } from '../src/agents/types.js';
import { controlPrefix } from '../src/cli/cli-control.js';
import { SessionCoordination } from '../src/core/coordination/coordination.js';
import { Coordinator } from '../src/core/coordinator.js';
import { JobWatch } from '../src/core/jobs/jobs.js';
import { router } from '../src/core/runtime/router.js';
import type { ProcessIdentity } from '../src/core/state.js';
import { Memory } from '../src/memory/memory.js';
import { callControl } from '../src/persistence/control.js';
import type { ControlBinding } from '../src/persistence/control.js';
import { DelegationStore } from '../src/persistence/delegation.js';
import { unlessGone, writeJson } from '../src/persistence/json.js';
import { ps, runs, stopLeftProcesses } from '../src/persistence/process.js';
import { StateStore } from '../src/persistence/store.js';
import { quote } from '../src/shell.js';
import { App } from '../src/ui/App.js';

const execute = promisify(execFile);

assert.ok(
  process.argv[2],
  'Supply a new task-owned directory under TMPDIR. This check uses native account usage.',
);

const root = resolve(process.argv[2]);
const project = join(root, 'project');
const checks: Check[] = [];
let binding: ControlBinding | undefined;

interface Check {
  name: string;
  runtime: 'codex' | 'claude';
  model: string;
  command: string;
  gate: string;
  audit: string;
  report: string;
  run?: string;
}

interface Processes {
  child: ProcessIdentity;
  wrapper: ProcessIdentity;
}

interface NativeExit {
  code: number | null;
  signal: string | null;
}

interface Command {
  line: MarkerLine;
  status?: string;
  exitCode?: number | null;
}

const commands = new Map<string, Command>();
const commandByRun = new Map<string, Command>();

for (const directory of [project, join(root, 'jobs'), join(root, 'tmp')])
  await mkdir(directory, { recursive: true });

process.env.TMPDIR = join(root, 'tmp');
process.env.CLAUDE_CODE_TMPDIR = join(root, 'tmp');
await execute('git', ['init', '-b', 'main'], { cwd: project });

await writeFile(
  join(project, 'packet.md'),
  '# Review packet\n\nA task starts running, retains its name, reports the native model and unique tool count, and completes only after its child exits successfully. A failed child cannot complete successfully.\n',
);

await writeFile(
  join(project, 'audit.mjs'),
  `import { ChildProcess, execFileSync } from 'node:child_process';
import { appendFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export function identity(pid) {
  const started = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: process.platform === 'linux' ? 'C.UTF-8' : undefined,
      LC_TIME: 'C', LC_NUMERIC: 'C', TZ: 'UTC' },
  }).trim();
  return { pid, started };
}

export function publish(file, value) {
  writeFileSync(file + '.tmp', JSON.stringify(value));
  renameSync(file + '.tmp', file);
}

const original = ChildProcess.prototype.spawn;
ChildProcess.prototype.spawn = function(options) {
  const result = original.call(this, options);
  const audit = process.env.WITCH_REVIEW_AUDIT;
  if (audit && isAbsolute(options.file) &&
      realpathSync(options.file) === process.env.WITCH_REVIEW_EXECUTABLE) {
    publish(audit + '.processes.json', {
      child: identity(this.pid), wrapper: identity(process.pid),
    });
    this.stdout.on('data', chunk => appendFileSync(audit + '.jsonl', chunk));
    this.once('exit', (code, signal) => publish(audit + '.exit.json', { code, signal }));
  }
  return result;
};
`,
);

await writeFile(
  join(project, 'gate.mjs'),
  `import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { identity, publish } from './audit.mjs';

const name = process.argv[2];
const worker = identity(process.pid);
publish(name + '.ready.json', worker);
const deadline = Date.now() + 180000;
while (!existsSync(name + '.release')) {
  if (Date.now() >= deadline) {
    publish(name + '.expired.json', worker);
    assert.fail('Gate was not released: ' + name);
  }
  await delay(100);
}
publish(name + '.released.json', worker);
`,
);

await writeFile(
  join(project, 'server.mjs'),
  `import { identity, publish } from './audit.mjs';
publish('server.json', identity(process.pid));
setTimeout(() => {}, 1200000);
`,
);

const state = await StateStore.open(join(root, 'state'));
const memory = new Memory(join(root, 'state/memory.git'));
const entry = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

const coordination = await SessionCoordination.open(
  state,
  memory,
  join(root, 'tmp/control'),
  (binding) => controlPrefix(binding, entry),
);

const jobs = new JobWatch({ directory: join(root, 'jobs'), interval: 100 });
const registrations = await installedAgents();
const native = registrations.find((agent) => agent.adapter.id === 'codex');

if (!native?.executable) {
  await writeJson(join(root, 'result.json'), {
    passed: false,
    error: 'Codex is not installed.',
  });

  await coordination.close();
  jobs.close();

  throw new Error('Codex is not installed.');
}

const adapter = new CodexAdapter((executable, cwd, signal) => {
  const child = spawn(executable, ['app-server', '--stdio'], {
    cwd,
    signal,
    stdio: 'pipe',
  });

  createInterface({ input: child.stdout }).on('line', (line) => {
    const frame = JSON.parse(line) as {
      method?: string;
      params?: {
        threadId: string;
        itemId?: string;
        delta?: string;
        item?: {
          id: string;
          type: string;
          status?: string;
          exitCode?: number | null;
        };
      };
    };

    if (frame.method) appendFileSync(join(root, 'native.jsonl'), line + '\n');

    const params = frame.params;

    if (!params) return;

    const { item } = params;
    const key = `${params.threadId}/${item?.id ?? params.itemId}`;

    if (item?.type === 'commandExecution') {
      if (frame.method === 'item/started')
        commands.set(key, { line: { partial: '', discarding: false } });
      else if (frame.method === 'item/completed') {
        const command = commands.get(key);

        if (command) {
          command.status = item.status;
          command.exitCode = item.exitCode;
        }
      }
    } else if (
      frame.method === 'item/commandExecution/outputDelta' &&
      params.delta &&
      binding
    ) {
      const command = commands.get(key);

      if (command)
        scanMarkers(command.line, params.delta, binding, (marker) =>
          commandByRun.set(marker.run, command),
        );
    }
  });

  return child;
});

const coordinator = new Coordinator(
  state,
  memory,
  registrations.map((registration) =>
    registration.adapter.id === 'codex'
      ? { ...registration, adapter }
      : registration,
  ),
  jobs,
  undefined,
  coordination,
);

coordination.router = router(
  coordinator,
  await DelegationStore.open(join(root, 'state/delegation')),
  (deadline) => coordination.routingDemand(deadline),
);

const application = render(
  createElement(App, { coordinator, jobs, onExit: () => {} }),
  { alternateScreen: true, exitOnCtrlC: false },
);

let previous = '';
let approved = new Set<string>();
const observed = new Set<string>();
let pending: Promise<void> | undefined;
let sendError: unknown;

const unsubscribe = coordinator.subscribe(() => {
  const { subagents, backgroundCommands, phase, requests } =
    coordinator.snapshot;

  const value = JSON.stringify({
    subagents,
    backgroundCommands,
    phase,
    requests,
  });

  if (value !== previous) {
    previous = value;

    appendFileSync(
      join(root, 'states.jsonl'),
      JSON.stringify({
        at: Date.now(),
        subagents,
        backgroundCommands,
        phase,
        requests,
      }) + '\n',
    );
  }
});

async function until(
  label: string,
  predicate: () => boolean | Promise<boolean>,
  seconds = 180,
) {
  const deadline = Date.now() + seconds * 1000;

  while (!(await predicate())) {
    if (sendError) throw sendError;

    if (coordinator.snapshot.phase === 'error')
      throw new Error(coordinator.snapshot.error);

    for (const request of coordinator.snapshot.requests) {
      if (observed.has(request.id)) continue;

      assert.equal(request.kind, 'approval', request.detail);
      const fields = JSON.parse(request.detail) as { command?: string };
      let command = fields.command;

      if (command) {
        const parsed = shellWords(command);

        if (
          parsed?.words.length === 3 &&
          ['sh', 'bash', 'zsh'].includes(basename(parsed.words[0]!)) &&
          ['-c', '-lc'].includes(parsed.words[1]!) &&
          !parsed.rest.trim()
        )
          command = parsed.words[2];
      }

      const gateOwner = checks.find(
        (check) =>
          check.gate === command &&
          request.id.startsWith(`familiar/${familiar(check)?.run}/`),
      );

      assert.ok(
        command && (approved.has(command) || gateOwner),
        'Unexpected native request: ' + request.detail,
      );

      await coordinator.respond(request.id, { decision: 'accept' });
      observed.add(request.id);
    }

    assert.ok(Date.now() < deadline, 'Timeout: ' + label);
    await delay(100);
  }
}

async function capture(name: string) {
  if (process.env.WITCH_CHECK_TMUX_SOCKET) {
    const { stdout } = await execute('tmux', [
      '-S',
      process.env.WITCH_CHECK_TMUX_SOCKET,
      'capture-pane',
      '-p',
      '-t',
      'check',
    ]);

    await writeFile(join(root, name + '.txt'), stdout);
  }

  await writeJson(join(root, name + '.json'), coordinator.snapshot);
}

async function command(
  runtime: Check['runtime'],
  name: string,
): Promise<Check> {
  assert.ok(binding);
  const selected = coordinator.snapshot.native;
  assert.equal(selected?.agent, 'codex');
  assert.ok(selected.model);

  const outcome = await callControl(binding, {
    kind: 'route',
    work: 'review',
    of: { runtime: 'codex', model: selected.model },
    named: { runtime, model: runtime === 'codex' ? 'astra' : 'opus' },
  });

  assert.equal(outcome.kind, 'route', JSON.stringify(outcome));
  assert.equal(outcome.routes.length, 1);
  const route = outcome.routes[0]!;
  assert.equal(route.runtime, runtime);

  const executable = registrations.find(
    (agent) => agent.adapter.id === runtime,
  )!.executable!;

  const audit = join(root, 'tmp', name);
  const report = join(root, 'tmp', name + '-report.txt');

  const gate = [process.execPath, join(project, 'gate.mjs'), name]
    .map(quote)
    .join(' ');

  const marker = name.toUpperCase() + ' CHECK PASSED';

  const prompt =
    'Read packet.md. Assess whether its completion rule prevents false success. ' +
    `Then run exactly this authorized command once and wait for it to exit: ${gate}\n` +
    'On Codex, use exec_command with sandbox_permissions require_escalated and yield_time_ms 1000 for this exact gate command, because its process identity capture requires /bin/ps; poll that session until it exits. On Claude, use Bash with timeout 180000. Native permission for that exact command is authorized by this isolated check.\n' +
    `Only after the gate exits 0, reply in at most two sentences and include ${marker} if the packet prevents false success. ` +
    'The gate writes only its authorized ready marker. Do not otherwise write files, delegate, rerun the command or release your gate.';

  const args =
    runtime === 'codex'
      ? [
          '--without-mcp',
          '--',
          '-c',
          quote(`model=${JSON.stringify(route.model)}`),
          '-c',
          quote('model_reasoning_effort="low"'),
        ]
      : [
          '--',
          '--model',
          quote(route.model),
          '--effort',
          'low',
          '--restricted',
          '--safe-mode',
          '--strict-mcp-config',
          '--mcp-config',
          quote('{"mcpServers":{}}'),
          '--tools',
          'Read,Bash',
          '--allowedTools',
          'Read',
          quote(`Bash(${gate})`),
          '--permission-prompts',
          'none',
          '--no-session-persistence',
        ];

  const invocation = [
    'env',
    'NODE_OPTIONS=' + quote('--import=' + join(project, 'audit.mjs')),
    'WITCH_REVIEW_AUDIT=' + quote(audit),
    'WITCH_REVIEW_EXECUTABLE=' + quote(realpathSync(executable)),
    coordination.commandPrefixes().familiar,
    '--familiar-' + runtime,
    quote(name),
    '--report-file',
    quote(report),
    ...args,
    "<<'WITCH_CHECK_PROMPT'\n" + prompt + '\nWITCH_CHECK_PROMPT',
  ].join(' ');

  const check = {
    name,
    runtime,
    model: route.model,
    command: invocation,
    gate,
    audit,
    report,
  };

  checks.push(check);
  await writeJson(join(root, name + '-route.json'), outcome);

  return check;
}

function send(prompt: string) {
  pending = coordinator.send(prompt);
  sendError = undefined;

  void pending.catch((error: unknown) => {
    sendError = error;
  });
}

async function readEvidence<T>(file: string): Promise<T | undefined> {
  const text = await unlessGone(readFile(file, 'utf8'));

  return text === undefined ? undefined : (JSON.parse(text) as T);
}

function familiar(check: Check) {
  const row = coordinator.snapshot.subagents.find(
    (row) => row.name === check.name && row.runtime === check.runtime,
  );

  if (row) {
    assert.ok(row.run);
    check.run ??= row.run;
    assert.equal(row.run, check.run);
  }

  return row;
}

async function ready(check: Check) {
  const row = familiar(check);

  if (!row) return false;

  assert.equal(row.status, 'running', row.report);

  const gate = await readEvidence<ProcessIdentity>(
    join(project, check.name + '.ready.json'),
  );

  const processes = await readEvidence<Processes>(
    check.audit + '.processes.json',
  );

  return (
    row.model === check.model &&
    (row.tools ?? 0) >= 1 &&
    !!gate &&
    !!processes &&
    (await belongsTo(gate, processes.child)) &&
    (await runs(processes.wrapper))
  );
}

async function belongsTo(gate: ProcessIdentity, child: ProcessIdentity) {
  if (!(await runs(gate)) || !(await runs(child))) return false;

  const parents = new Map(
    (await ps('pid=,ppid=')).map((line) => {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number);

      return [pid!, ppid!] as const;
    }),
  );

  let pid = gate.pid;

  while (pid && pid !== child.pid) pid = parents.get(pid) ?? 0;

  return pid === child.pid && (await runs(gate)) && (await runs(child));
}

async function completed(check: Check) {
  const row = familiar(check);

  if (!row) return false;

  if (row.status !== 'running')
    assert.equal(row.status, 'completed', row.report);

  const command = row.run ? commandByRun.get(row.run) : undefined;

  if (command?.status) {
    assert.equal(command.status, 'completed');
    assert.equal(command.exitCode, 0, `${check.name} wrapper exit`);
  }

  if (row.status !== 'completed' || !command?.status) return false;

  assert.equal(row.model, check.model);
  const report = await readFile(check.report, 'utf8');
  assert.equal(report, row.report);
  assert.ok(report.includes(check.name.toUpperCase() + ' CHECK PASSED'));

  if (check.runtime === 'claude') {
    const stream = await readFile(check.audit + '.jsonl', 'utf8');

    for (const line of stream.trim().split('\n')) {
      const message = JSON.parse(line) as {
        type: string;
        permission_denials: unknown[];
      };

      if (message.type === 'result')
        assert.deepEqual(
          message.permission_denials,
          [],
          `${check.name} native permission denials`,
        );
    }
  }

  const nativeExit = await readEvidence<NativeExit>(check.audit + '.exit.json');
  assert.deepEqual(nativeExit, { code: 0, signal: null });

  const processes = await readEvidence<Processes>(
    check.audit + '.processes.json',
  );

  const gate = await readEvidence<ProcessIdentity>(
    join(project, check.name + '.ready.json'),
  );

  assert.ok(processes && gate);

  assert.deepEqual(
    await readEvidence<ProcessIdentity>(
      join(project, check.name + '.released.json'),
    ),
    gate,
    `${check.name} gate release receipt`,
  );

  if (
    (await runs(processes.child)) ||
    (await runs(processes.wrapper)) ||
    (await runs(gate))
  )
    return false;

  return true;
}

let passed = false;
let failure: string | undefined;
const cleanupErrors: string[] = [];

try {
  await coordinator.initialize(project);

  await coordinator.selectModel({
    agent: 'codex',
    id: 'gpt-6.1-sol',
    effort: 'low',
  });

  binding = await coordination.activate(
    coordinator.snapshot.conversation!,
    (await memory.scopePaths(project)).project,
  );

  const claim = await callControl(binding, {
    kind: 'claim',
    input: {
      reference: 'task:familiar-live-check',
      summary: 'Run the authorized isolated familiar acceptance check',
      aliases: [],
    },
  });

  assert.equal(claim.kind, 'claimed');
  const astra = await command('codex', 'astra-live');
  const opus = await command('claude', 'opus-live');

  const server = [process.execPath, join(project, 'server.mjs')]
    .map(quote)
    .join(' ');

  approved = new Set([astra.command, opus.command, server]);

  send(
    'This isolated live acceptance check is approved and already claimed. The driver has routed each familiar through Witch and supplied its exact wrapper command. Execute exactly the three commands below, each in a separate exec_command call with workdir ' +
      project +
      ', yield_time_ms 1000, max_output_tokens 1000 and sandbox_permissions require_escalated for account-backed native access. These exact commands are authorized. Preserve their stdout and stdin heredocs. Return STARTED after launching, without waiting for any command to finish. Do not use native subagent tools, delegate additional work, kill commands, release gates, rerun anything or perform other work.\n\nCodex review:\n' +
      astra.command +
      '\n\nClaude review:\n' +
      opus.command +
      '\n\nUnrelated command:\n' +
      server,
  );

  await until(
    'both routed familiars at their gates and the unrelated server',
    async () =>
      (await ready(astra)) &&
      (await ready(opus)) &&
      !!(await readEvidence<ProcessIdentity>(join(project, 'server.json'))),
  );

  await capture('concurrent');
  await writeFile(join(project, astra.name + '.release'), 'release');
  await writeFile(join(project, opus.name + '.release'), 'release');

  await until(
    'both saved reports and successful wrapper exits',
    async () =>
      (await completed(astra)) &&
      (await completed(opus)) &&
      coordinator.snapshot.phase === 'idle',
  );

  await pending;
  assert.equal(coordinator.snapshot.subagents.length, 2);
  assert.equal(coordinator.snapshot.backgroundCommands.length, 1);

  assert.ok(
    !/--familiar-(claude|codex)/.test(
      coordinator.snapshot.backgroundCommands[0]!.description,
    ),
  );

  await capture('completed');

  for (const mode of ['child-stop', 'wrapper-loss', 'job-stop'] as const) {
    const review = await command('claude', mode);
    approved = new Set([review.command]);

    send(
      'Launch exactly this authorized command using exec_command with workdir ' +
        project +
        ', yield_time_ms 1000, max_output_tokens 1000 and sandbox_permissions require_escalated for its account-backed native access, then return STARTED without waiting. The driver has routed this familiar through Witch. Preserve its stdout and stdin heredoc. This is the next controlled interruption check. Do not rerun it, kill it, release its gate, delegate or perform other work.\n' +
        review.command,
    );

    await until(mode + ' native child at its gate', () => ready(review));

    const processes = await readEvidence<Processes>(
      review.audit + '.processes.json',
    );

    const gate = await readEvidence<ProcessIdentity>(
      join(project, mode + '.ready.json'),
    );

    assert.ok(processes && gate);
    const { child, wrapper } = processes;

    if (mode === 'job-stop') {
      assert.ok(await runs(wrapper));
      const group = Number((await ps('pgid=', [wrapper.pid]))[0]!.trim());
      const job = (await jobs.list()).find((job) => job.group === group);
      assert.ok(job, 'registered review remains owned by jobs');
      await jobs.stop(job);
    } else {
      const target = mode === 'child-stop' ? child : wrapper;
      assert.ok(await runs(target));
      process.kill(target.pid, mode === 'child-stop' ? 'SIGTERM' : 'SIGKILL');
    }

    await until(
      mode + ' terminal state',
      () => familiar(review)?.status !== 'running',
      10,
    );

    const nativeExit = await readEvidence<NativeExit>(
      review.audit + '.exit.json',
    );

    let expected: 'failed' | 'stopped' =
      mode === 'job-stop' ? 'stopped' : 'failed';

    if (mode === 'child-stop') {
      assert.ok(nativeExit);
      expected = nativeExit.signal ? 'stopped' : 'failed';
    }

    assert.equal(familiar(review)?.status, expected);

    await until(
      mode + ' native cleanup',
      async () => !(await runs(child)) && !(await runs(wrapper)),
      10,
    );

    await stopLeftProcesses({ process: gate });

    assert.equal(
      await readEvidence(join(project, mode + '.expired.json')),
      undefined,
      `${mode} gate expired before cleanup`,
    );

    await until(
      mode + ' parent usable',
      () => coordinator.snapshot.phase === 'idle',
    );

    await pending;
    await capture(mode);
  }

  const serverIdentity = await readEvidence<ProcessIdentity>(
    join(project, 'server.json'),
  );

  assert.ok(serverIdentity && (await runs(serverIdentity)));
  const group = Number((await ps('pgid=', [serverIdentity.pid]))[0]!.trim());
  const job = (await jobs.list()).find((job) => job.group === group);
  assert.ok(job);
  await jobs.stop(job);

  await until(
    'unrelated job cleanup',
    async () => !(await runs(serverIdentity)),
  );

  passed = true;
} catch (error) {
  failure = error instanceof Error ? error.stack : String(error);

  await capture('failure').catch((error: unknown) =>
    cleanupErrors.push(String(error)),
  );
} finally {
  const clean = async (action: () => Promise<unknown>) => {
    try {
      await action();
    } catch (error) {
      cleanupErrors.push(
        error instanceof Error ? (error.stack ?? error.message) : String(error),
      );
    }
  };

  await clean(() => coordinator.interrupt());

  await clean(async () => {
    for (const job of await jobs.list()) await clean(() => jobs.stop(job));
  });

  for (const check of checks) {
    await clean(async () => {
      const processes = await readEvidence<Processes>(
        check.audit + '.processes.json',
      );

      const gate = await readEvidence<ProcessIdentity>(
        join(project, check.name + '.ready.json'),
      );

      for (const identity of [processes?.wrapper, processes?.child, gate])
        if (identity)
          await clean(() => stopLeftProcesses({ process: identity }));
    });
  }

  await clean(async () => {
    const server = await readEvidence<ProcessIdentity>(
      join(project, 'server.json'),
    );

    if (server) await stopLeftProcesses({ process: server });
  });

  await clean(async () => {
    await pending;
  });

  await clean(() => coordinator.close());
  unsubscribe();
  jobs.close();
  application.unmount();
  const lastRows = new Map<string, Subagent>();

  const history = await unlessGone(
    readFile(join(root, 'states.jsonl'), 'utf8'),
  );

  for (const line of history?.split('\n').filter(Boolean) ?? []) {
    const event = JSON.parse(line) as { subagents: Subagent[] };

    for (const row of event.subagents) if (row.run) lastRows.set(row.run, row);
  }

  const result = {
    passed: passed && !cleanupErrors.length,
    error: failure,
    cleanupErrors,
    checks: checks.map((check) => ({
      name: check.name,
      runtime: check.runtime,
      model: check.model,
      run: check.run,
      status: check.run ? lastRows.get(check.run)?.status : undefined,
      report: relative(root, check.report),
      wrapperExit: check.run
        ? commandByRun.get(check.run)?.exitCode
        : undefined,
    })),
    cleanup: cleanupErrors.length ? 'incomplete' : 'verified',
  };

  await writeJson(join(root, 'result.json'), result);

  if (!result.passed) process.exitCode = 1;
}
