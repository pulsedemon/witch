import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { verificationAdapter } from './native-verification-profile.js';
import type { VerificationLaunch } from './native-verification-profile.js';
import { checkNativeAnswer } from './native-answer-check.js';
import { checkCodexAnswerSandbox } from './native-sandbox-check.js';
import { checkNativeSettings } from './native-settings-check.js';
import { nativeScenario } from './native-scenario.js';
import type { NativeScenario } from './native-scenario.js';
import { artifactDigest } from './runtime-updates.js';
import type { NativeRuntime, RuntimeInstallation } from './runtime-updates.js';
import type {
  AgentEvent,
  AgentSession,
  SessionOptions,
  TurnResult,
  UserRequest,
} from '../types.js';
import { unlessGone, writeJson } from '../../persistence/json.js';
import { errorMessage } from '../../errors.js';

export const verificationProfile = 'native-update-1';
const execute = promisify(execFile);

function nativeScenarios(runtime: NativeRuntime): NativeScenario[] {
  return [
    'basic',
    'control',
    'background',
    'spell',
    ...(runtime === 'claude' ? ['idle-run' as const] : []),
  ];
}

export function requiredNativeChecks(runtime: NativeRuntime): string[] {
  return [
    'cross-version resume',
    'native approval and denial',
    'ordinary settings',
    'automatic answer boundaries',
    ...(runtime === 'codex' ? ['native answer sandbox'] : []),
    ...nativeScenarios(runtime),
  ];
}

interface PreparedNativeUpdate {
  directory: string;
  runtime: NativeRuntime;
  previous: RuntimeInstallation;
  model: string;
  sessionId: string;
  marker: string;
}

interface NativeVerificationOptions {
  directory: string;
  build: string;
  launch?: VerificationLaunch;
  model?: string;
  allowAccountUsage: boolean;
  signal: AbortSignal;
  progress(message: string): void;
}

export interface NativeVerificationReport {
  profile: string;
  build: string;
  runtime: NativeRuntime;
  previous: RuntimeInstallation;
  candidate: RuntimeInstallation;
  sdkVersion: string;
  evidenceDirectory: string;
  model: string;
  completed: string[];
  passed: boolean;
  error?: string;
  diagnostic?: string;
}

async function project(directory: string, spells = false): Promise<string> {
  const cwd = join(directory, 'project');
  await mkdir(cwd, { recursive: true, mode: 0o700 });

  const instructions =
    'This is a synthetic native compatibility check. Perform only the exact prompt. Do not commit files.\n';

  await writeFile(join(cwd, 'AGENTS.md'), instructions);
  await writeFile(join(cwd, 'CLAUDE.md'), instructions);

  if (spells) {
    for (const source of ['.claude/skills', '.agents/skills']) {
      const path = join(cwd, source, 'probe-spell');
      await mkdir(path, { recursive: true });

      await writeFile(
        join(path, 'SKILL.md'),
        '---\nname: probe-spell\ndescription: Answers the synthetic native probe.\n---\n\nReply with exactly `PROBE CAST` followed by any arguments. Do nothing else.\n',
      );
    }

    await execute('git', ['init', '-q'], { cwd });
  }

  return cwd;
}

function completed(result: TurnResult): void {
  assert.equal(
    result.status,
    'completed',
    result.error ?? 'Native check did not complete',
  );
}

function sessionOptions(
  executable: string,
  cwd: string,
  model: string,
  signal: AbortSignal,
  onEvent: (event: AgentEvent) => void,
): SessionOptions {
  return {
    executable,
    cwd,
    model,
    effort: 'low',
    memoryDirectories: [],
    signal,
    onEvent,
    onProcess: async () => {},
  };
}

export async function prepareNativeUpdate(
  previous: RuntimeInstallation,
  options: NativeVerificationOptions,
): Promise<PreparedNativeUpdate> {
  if (!options.allowAccountUsage)
    throw new Error('Native qualification requires account-usage consent.');

  const directory = join(options.directory, 'resume');
  const cwd = await project(directory);

  const adapter = await verificationAdapter(previous.runtime, directory, {
    start: options.launch,
  });

  const models = await adapter.models({
    executable: previous.executable,
    cwd,
    signal: options.signal,
  });

  const preferred = previous.runtime === 'claude' ? ['haiku'] : ['gpt-6.1-sol'];

  const model =
    options.model ??
    preferred.find((id) => models.some((model) => model.id === id));

  if (!model || !models.some((value) => value.id === model))
    throw new Error('Choose an available model for native qualification.');

  const marker = `WITCH_RESUME_${randomBytes(16).toString('hex')}`;
  const events: AgentEvent[] = [];

  const session = await adapter.connect(
    sessionOptions(previous.executable, cwd, model, options.signal, (event) =>
      events.push(event),
    ),
  );

  try {
    options.progress(
      `Preparing ${previous.runtime} conversation on ${previous.version}`,
    );

    const result = await session.send(
      `Remember the exact marker ${marker} for recall after compaction and reconnect. Reply only with the marker. Do not use tools, skills or delegation.`,
    );

    completed(result);
    assert.equal(result.text.trim(), marker);
    completed(await session.compact());

    assert.equal(
      events.some((event) => event.type === 'tool'),
      false,
      'Resume preparation used tools',
    );

    return {
      directory,
      runtime: previous.runtime,
      previous,
      model,
      marker,
      sessionId: session.info.id,
    };
  } finally {
    try {
      await session.close();
    } finally {
      await writeJson(join(directory, 'prepare-events.json'), events);
    }
  }
}

async function recall(
  prepared: PreparedNativeUpdate,
  executable: string,
  options: NativeVerificationOptions,
): Promise<void> {
  const adapter = await verificationAdapter(
    prepared.runtime,
    prepared.directory,
    { start: options.launch },
  );

  const events: AgentEvent[] = [];

  const session = await adapter.connect({
    ...sessionOptions(
      executable,
      join(prepared.directory, 'project'),
      prepared.model,
      options.signal,
      (event) => events.push(event),
    ),
    resume: prepared.sessionId,
  });

  try {
    assert.equal(session.info.id, prepared.sessionId);

    const result = await session.send(
      'Reply only with the exact marker I asked you to remember before compaction and reconnect. Do not use tools, read files, load skills or delegate.',
    );

    completed(result);

    assert.equal(
      result.text.trim(),
      prepared.marker,
      'Native resume lost the previous conversation context',
    );

    assert.equal(
      events.some((event) => event.type === 'tool'),
      false,
      'Native recall used tools',
    );
  } finally {
    try {
      await session.close();
    } finally {
      await writeJson(join(prepared.directory, 'recall-events.json'), events);
    }
  }
}

async function checkNativeApprovals(
  candidate: RuntimeInstallation,
  model: string,
  options: NativeVerificationOptions,
): Promise<void> {
  const directory = join(options.directory, 'approvals');
  const cwd = await project(directory);

  const adapter = await verificationAdapter(candidate.runtime, directory, {
    start: options.launch,
  });

  let expected = '';
  let accept = false;
  let requests = 0;
  let approvalTool: string | undefined;
  const pending: Promise<void>[] = [];
  const events: AgentEvent[] = [];
  let requestFailure: unknown;
  const failure = new AbortController();

  const respond = async (request: UserRequest) => {
    assert.equal(request.kind, 'approval', 'Unexpected native question');

    const { command, itemId } = JSON.parse(request.detail) as {
      command?: string;
      itemId?: string;
    };

    approvalTool = itemId ?? request.id;

    assert.ok(
      command === `node ${expected}.mjs` ||
        command === `/bin/zsh -lc 'node ${expected}.mjs'`,
      `Unexpected probe command: ${command}`,
    );

    assert.equal(
      await unlessGone(readFile(join(cwd, expected))),
      undefined,
      'The native tool wrote before approval',
    );

    requests++;

    assert.equal(
      requests,
      1,
      'Native probe requested an alternate/repeated approval',
    );

    session!.respond(request.id, { decision: accept ? 'accept' : 'decline' });
  };

  const session: AgentSession = await adapter.connect(
    sessionOptions(
      candidate.executable,
      cwd,
      model,
      AbortSignal.any([options.signal, failure.signal]),
      (event) => {
        events.push(event);

        if (event.type === 'request')
          pending.push(
            respond(event.request).catch((error) => {
              requestFailure = error;
              failure.abort(error);
            }),
          );
      },
    ),
  );

  try {
    for (const allowed of [false, true]) {
      accept = allowed;
      expected = allowed ? 'approved-result' : 'declined-result';
      requests = 0;
      approvalTool = undefined;
      const from = events.length;

      await writeFile(
        join(cwd, `${expected}.mjs`),
        `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(expected)}, ${JSON.stringify(expected)});\n`,
      );

      completed(
        await session.send(
          `Run exactly \`node ${expected}.mjs\` once, requesting native approval. If declined, stop without trying any other tool or command. Do not read files, load skills or delegate. Reply only DONE when the attempt ends.`,
        ),
      );

      await Promise.all(pending);

      if (requestFailure) throw requestFailure;

      assert.equal(requests, 1, 'The native write did not request approval');

      assert.deepEqual(
        [
          ...new Set(
            events
              .slice(from)
              .filter((event) => event.type === 'tool')
              .map((event) => event.id),
          ),
        ],
        [approvalTool],
        'Native approval check ran an unexpected tool',
      );

      assert.equal(
        await unlessGone(readFile(join(cwd, expected), 'utf8')),
        allowed ? expected : undefined,
        allowed
          ? 'Approved write did not complete'
          : 'Declined write changed its target',
      );
    }
  } catch (error) {
    // a failed approval aborts the session, so the turn's own failure only says it was aborted
    throw requestFailure ?? error;
  } finally {
    try {
      await session.close();
    } finally {
      await Promise.allSettled(pending);
      await writeJson(join(directory, 'events.json'), events);
    }
  }
}

export async function verifyNativeUpdate(
  prepared: PreparedNativeUpdate,
  candidate: RuntimeInstallation,
  options: NativeVerificationOptions,
): Promise<NativeVerificationReport> {
  if (!options.allowAccountUsage)
    throw new Error('Native qualification requires account-usage consent.');

  assert.equal(candidate.runtime, prepared.runtime);

  assert.equal(
    await artifactDigest(candidate.runtime, candidate.executable),
    candidate.digest,
    'Candidate changed before qualification',
  );

  const report: NativeVerificationReport = {
    profile: verificationProfile,
    build: options.build,
    runtime: candidate.runtime,
    previous: prepared.previous,
    candidate,
    sdkVersion: (
      JSON.parse(
        await readFile(
          join(
            dirname(
              fileURLToPath(
                import.meta.resolve('@anthropic-ai/claude-agent-sdk'),
              ),
            ),
            'package.json',
          ),
          'utf8',
        ),
      ) as { version: string }
    ).version,
    evidenceDirectory: options.directory,
    model: prepared.model,
    completed: [],
    passed: false,
  };

  const check = async (name: string, run: () => Promise<unknown>) => {
    options.signal.throwIfAborted();
    options.progress(`Checking ${candidate.runtime}: ${name}`);
    await run();
    report.completed.push(name);
    await writeJson(join(options.directory, 'qualification.json'), report);
  };

  try {
    await check('cross-version resume', () =>
      recall(prepared, candidate.executable, options),
    );

    await check('native approval and denial', () =>
      checkNativeApprovals(candidate, prepared.model, options),
    );

    await check('ordinary settings', () =>
      checkNativeSettings(
        candidate,
        prepared.model,
        join(options.directory, 'settings'),
        options.signal,
      ),
    );

    await check('automatic answer boundaries', () =>
      checkNativeAnswer(
        candidate,
        prepared.model,
        join(options.directory, 'answer'),
        options.signal,
      ),
    );

    if (candidate.runtime === 'codex')
      await check('native answer sandbox', () =>
        checkCodexAnswerSandbox(
          candidate.executable,
          join(options.directory, 'sandbox'),
          options.signal,
        ),
      );

    for (const scenario of nativeScenarios(candidate.runtime)) {
      const directory = join(options.directory, scenario);
      const cwd = await project(directory, scenario === 'spell');

      const adapter = await verificationAdapter(candidate.runtime, directory, {
        start: options.launch,
      });

      const events: AgentEvent[] = [];

      await check(scenario, async () => {
        try {
          return await nativeScenario(
            adapter,
            sessionOptions(
              candidate.executable,
              cwd,
              prepared.model,
              options.signal,
              () => {},
            ),
            scenario,
            (event) => events.push(event),
            true,
          );
        } finally {
          await writeJson(join(directory, 'events.json'), events);
        }
      });
    }

    assert.equal(
      await artifactDigest(candidate.runtime, candidate.executable),
      candidate.digest,
      'Candidate changed during qualification',
    );

    assert.deepEqual(
      report.completed,
      requiredNativeChecks(candidate.runtime),
      'Native qualification omitted a required check',
    );

    report.passed = true;
  } catch (error) {
    report.error = errorMessage(error);
    report.diagnostic = error instanceof Error ? error.stack : String(error);

    throw error;
  } finally {
    await writeJson(join(options.directory, 'qualification.json'), report);
  }

  return report;
}
