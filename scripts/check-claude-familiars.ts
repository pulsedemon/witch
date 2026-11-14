import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createElement } from 'react';
import { render } from 'ink';
import { CodexAdapter } from '../src/agents/codex.js';
import { installedAgents } from '../src/agents/registry.js';
import { controlPrefix } from '../src/cli-control.js';
import { SessionCoordination } from '../src/core/coordination.js';
import { Coordinator } from '../src/core/coordinator.js';
import { JobWatch } from '../src/core/jobs.js';
import { Memory } from '../src/memory/memory.js';
import { callControl } from '../src/persistence/control.js';
import { writeJson } from '../src/persistence/json.js';
import { identifyProcess, ps } from '../src/persistence/process.js';
import { StateStore } from '../src/persistence/store.js';
import { quote } from '../src/shell.js';
import { App } from '../src/ui/app.js';

const execute = promisify(execFile);

assert.ok(
  process.argv[2],
  'Supply a new task-owned directory under TMPDIR. This check uses native account usage.',
);

const root = resolve(process.argv[2]);

const project = join(root, 'project');

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
  join(root, 'audit.mjs'),
  [
    "import {ChildProcess} from 'node:child_process';",
    "import {appendFileSync,writeFileSync} from 'node:fs';",
    'const original=ChildProcess.prototype.spawn;',
    "ChildProcess.prototype.spawn=function(options){const result=original.call(this,options);if(options.file==='claude'&&process.env.WITCH_REVIEW_AUDIT){writeFileSync(process.env.WITCH_REVIEW_AUDIT+'.pid',String(this.pid));writeFileSync(process.env.WITCH_REVIEW_AUDIT+'.wrapper',String(process.pid));this.stdout.on('data',chunk=>appendFileSync(process.env.WITCH_REVIEW_AUDIT,chunk));}return result;};",
  ].join('\n'),
);

const state = await StateStore.open(join(root, 'state'));

const memory = new Memory(join(root, 'state/memory.git'));

const entry = fileURLToPath(new URL('../src/cli.tsx', import.meta.url));

const coordination = await SessionCoordination.open(
  state,
  memory,
  join(root, 'tmp/control'),
  (binding) => controlPrefix(binding, entry),
);

const jobs = new JobWatch({ directory: join(root, 'jobs'), interval: 100 });

const native = (await installedAgents()).find(
  (agent) => agent.adapter.id === 'codex',
);

assert.ok(native?.executable);

const adapter = new CodexAdapter((executable, cwd, signal) => {
  const child = spawn(executable, ['app-server', '--stdio'], {
    cwd,
    signal,
    stdio: 'pipe',
  });

  createInterface({ input: child.stdout }).on('line', (line) => {
    const frame = JSON.parse(line) as { method?: string };

    if (frame.method) appendFileSync(join(root, 'native.jsonl'), line + '\n');
  });

  return child;
});

const coordinator = new Coordinator(
  state,
  memory,
  [{ adapter, executable: native.executable }],
  jobs,
  undefined,
  coordination,
);

const application = render(
  createElement(App, { coordinator, jobs, onExit: () => {} }),
  { alternateScreen: true, exitOnCtrlC: false },
);

let previous = '';

let approved = new Set<string>();

let observed = '';

let pending: Promise<void> | undefined;

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
    for (const request of coordinator.snapshot.requests) {
      if (request.id === observed) continue;

      observed = request.id;

      const fields = JSON.parse(request.detail) as { command?: string };

      assert.ok(
        request.kind === 'approval' &&
          fields.command &&
          approved.has(fields.command),
        'Unexpected native request: ' + request.detail,
      );

      await coordinator.respond(request.id, { decision: 'accept' });
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

function command(name: string) {
  const audit = join(root, 'tmp', name + '.jsonl');

  const prompt =
    'Read packet.md with Read. Assess whether its completion rule prevents false success. Reply in at most two sentences and include OPUS CHECK PASSED if it does. Do not change files or delegate.';

  return [
    'env',
    'NODE_OPTIONS=' + quote('--import=' + join(root, 'audit.mjs')),
    'WITCH_REVIEW_AUDIT=' + quote(audit),
    coordination.commandPrefixes().familiar,
    '--familiar-claude',
    quote(name),
    '--report-file',
    quote(join(root, 'tmp', name + '-report.txt')),
    '-- --model claude-opus-5-5 --effort low --restricted --safe-mode --strict-mcp-config',
    '--mcp-config',
    quote('{"mcpServers":{}}'),
    '--tools Read --allowedTools Read --permission-prompts none --no-session-persistence',
    quote(prompt),
  ].join(' ');
}

function send(prompt: string) {
  pending = coordinator.send(prompt);

  void pending.catch(() => {});
}

try {
  await coordinator.initialize(project);

  await coordinator.selectModel({
    agent: 'codex',
    id: 'gpt-6.1-sol',
    effort: 'low',
  });

  const binding = await coordination.activate(
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

  const review = command('opus-live');

  const server =
    quote(process.execPath) +
    ' -e ' +
    quote(
      "require('fs').writeFileSync('server.pid',String(process.pid));setTimeout(()=>{},300000)",
    );

  approved = new Set([review, server]);

  send(
    'This isolated live acceptance check is approved and already claimed. Do exactly these three launches, preserving each command. First spawn one native gpt-6-astra familiar with fork_turns none named astra_live. Its task: read packet.md, run sleep 45 once to keep this observation window open, then report ASTRA CHECK PASSED if the packet prevents false success. Do not write files or delegate. Then launch the Claude review below using exec_command with workdir ' +
      project +
      ', yield_time_ms 1000, max_output_tokens 1000 and sandbox_permissions require_escalated for its account-backed native access. Native approval for this exact command is authorized. Finally launch the unrelated command below with the same workdir/yield. Return STARTED after launching, without waiting for either familiar. Do not kill them or perform other work.\n\nClaude review:\n' +
      review +
      '\n\nUnrelated command:\n' +
      server,
  );

  await until(
    'both native familiars',
    () =>
      coordinator.snapshot.subagents.some(
        (s) => s.runtime === 'claude' && s.status === 'running' && s.model,
      ) &&
      coordinator.snapshot.subagents.some(
        (s) => s.runtime !== 'claude' && s.status === 'running',
      ),
  );

  await capture('concurrent');

  await until(
    'both review reports',
    () =>
      coordinator.snapshot.subagents.filter((s) => s.status === 'completed')
        .length === 2 && coordinator.snapshot.phase === 'idle',
  );

  await pending;

  const reviewers = coordinator.snapshot.subagents;

  assert.equal(reviewers.length, 2);

  assert.ok(reviewers.find((s) => s.runtime === 'claude')!.tools! >= 1);

  assert.match(
    reviewers.find((s) => s.runtime === 'claude')!.report!,
    /OPUS CHECK PASSED/,
  );

  assert.match(
    reviewers.find((s) => s.runtime !== 'claude')!.report!,
    /ASTRA CHECK PASSED/,
  );

  assert.equal(coordinator.snapshot.backgroundCommands.length, 1);

  assert.ok(
    !coordinator.snapshot.backgroundCommands[0]!.description.includes(
      '--familiar-claude',
    ),
  );

  await capture('completed');

  for (const mode of ['child-stop', 'wrapper-loss', 'job-stop'] as const) {
    const review = command(mode);

    approved = new Set([review]);

    send(
      'Launch exactly this authorized command using exec_command with workdir ' +
        project +
        ', yield_time_ms 1000, max_output_tokens 1000 and sandbox_permissions require_escalated for its account-backed native access, then return STARTED without waiting. This is the next controlled interruption check. Do not rerun it, kill it, or perform other work.\n' +
        review,
    );

    await until(mode + ' native child', async () => {
      const text = await readFile(
        join(root, 'tmp', mode + '.jsonl.pid'),
        'utf8',
      ).catch(() => '');

      return (
        !!text &&
        coordinator.snapshot.subagents.some(
          (s) => s.name === mode && s.status === 'running',
        )
      );
    });

    const pid = Number(
      await readFile(join(root, 'tmp', mode + '.jsonl.pid'), 'utf8'),
    );

    const wrapper = Number(
      await readFile(join(root, 'tmp', mode + '.jsonl.wrapper'), 'utf8'),
    );

    const childIdentity = await identifyProcess(pid);

    assert.ok(childIdentity);

    if (mode === 'job-stop') {
      const group = Number((await ps('pgid=', [wrapper]))[0]!.trim());

      const job = (await jobs.list()).find((job) => job.group === group);

      assert.ok(job, 'registered review remains owned by jobs');

      await jobs.stop(job);
    } else
      process.kill(
        mode === 'child-stop' ? pid : wrapper,
        mode === 'child-stop' ? 'SIGTERM' : 'SIGKILL',
      );

    await until(mode + ' terminal state', () =>
      coordinator.snapshot.subagents.some(
        (s) => s.name === mode && s.status !== 'running',
      ),
    );

    const familiar = coordinator.snapshot.subagents.find(
      (s) => s.name === mode,
    )!;

    assert.equal(
      familiar.status,
      mode === 'wrapper-loss' ? 'failed' : 'stopped',
    );

    await until(
      mode + ' native cleanup',
      async () =>
        (await identifyProcess(pid))?.started !== childIdentity.started,
    );

    await until(
      mode + ' parent usable',
      () => coordinator.snapshot.phase === 'idle',
    );

    await pending;

    await capture(mode);
  }

  const serverPid = Number(await readFile(join(project, 'server.pid'), 'utf8'));

  const group = Number((await ps('pgid=', [serverPid]))[0]!.trim());

  const job = (await jobs.list()).find((job) => job.group === group);

  assert.ok(job);

  await jobs.stop(job);

  await until(
    'unrelated job cleanup',
    async () => !(await identifyProcess(serverPid)),
  );

  await writeJson(join(root, 'result.json'), {
    passed: true,
    checks: [
      'concurrent Astra/Opus',
      'observed model and tool activity',
      'one unrelated brew',
      'complete saved report',
      'child termination',
      'wrapper-only death',
      'job ownership and group stop',
      'parent remains usable',
    ],
  });
} catch (error) {
  await capture('failure');

  await writeJson(join(root, 'result.json'), {
    passed: false,
    error: error instanceof Error ? error.stack : String(error),
  });

  process.exitCode = 1;
} finally {
  await coordinator.interrupt();

  try {
    await pending?.catch(() => {});

    await coordinator.close();
  } finally {
    unsubscribe();

    jobs.close();

    application.unmount();
  }
}
