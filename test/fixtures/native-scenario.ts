import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  AgentAdapter,
  AgentEvent,
  AgentSession,
  SessionOptions,
  UserRequest,
  UserResponse,
} from '../../src/agents/types.js';
import { within, until } from './within.js';
import { familiarMarker } from '../../src/agents/familiar-report.js';
import { skillCall } from '../../src/core/prompts.js';

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
  const abort = new AbortController();
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
      onProcess: async () => {},
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
        undefined,
        'The protocol check marker is WITCH_CONTEXT_309.',
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
      await writeFile(
        join(options.cwd, 'probe.mjs'),
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
      await writeFile(
        join(options.cwd, 'probe.mjs'),
        "console.log('WITCH_WAIT_309'); setTimeout(() => {}, 15000);\n",
      );
      const prompt =
        'Run exactly `node probe.mjs` in the foreground. Do not use other tools, spells or delegation. When it ends reply only WITCH_CONTROL_309.';
      const started = events.length;
      const sending = session.send(prompt);
      void sending.catch(() => {});
      await until(
        'native tool start',
        () =>
          events
            .slice(started)
            .some((event) => event.type === 'tool' && !event.done),
        4500,
      );
      assert.equal(
        await session.steer('Also include STEER_309 in the final reply.'),
        true,
      );
      const steered = await within(sending, 120000, 'steered native turn');
      assert.equal(steered.status, 'completed', steered.error);
      assert.match(steered.text, /STEER_309/);
      const before = events.length;
      const interrupted = session.send(prompt);
      void interrupted.catch(() => {});
      await until(
        'interrupt tool start',
        () =>
          events
            .slice(before)
            .some((event) => event.type === 'tool' && !event.done),
        4500,
      );
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
      const user = await session.send(prompt, call);
      assert.equal(user.status, 'completed', user.error);
      assert.match(user.text, /PROBE CAST hello/);
      assert.ok(cast(from), 'the user casts the probe spell');
    } else if (scenario === 'idle-run') {
      // the second run, started by Claude Code after the brew ends, sleeps so a prompt lands inside it
      await writeFile(
        join(options.cwd, 'probe.mjs'),
        "import {existsSync} from 'node:fs'; if (existsSync('emit')) setTimeout(() => console.log('WITCH_SLOW_505'), 8000); else { const timer = setInterval(() => { if (existsSync('emit')) { clearInterval(timer); console.log('WITCH_DONE_505'); } }, 20); }\n",
      );
      const started = await session.send(
        'Run exactly `node probe.mjs` with Bash run_in_background=true. Do not read files, load spells or delegate. Reply only WITCH_BACKGROUND_505 after starting it. When it finishes, run exactly `node probe.mjs` once more in the foreground, then reply only WITCH_NATIVE_505.',
      );
      assert.equal(started.status, 'completed', started.error);
      await until(
        'native background membership',
        () =>
          events.some(
            (event) =>
              event.type === 'command' && event.command.status === 'running',
          ),
        1500,
      );
      const from = events.length;
      await writeFile(join(options.cwd, 'emit'), 'emit');
      // the approval comes from the run Claude Code starts once the brew ends, and is answered as it arrives, so the
      // prompt follows it on the wire
      await until(
        'native tool approval',
        () => events.slice(from).some((event) => event.type === 'request'),
        3000,
      );
      // Claude Code takes the prompt into its own run at the next tool boundary, and that run's result names it
      const prompted = await session.send(
        'Reply only WITCH_PROMPT_505. Do not use tools, spells or delegation.',
      );
      assert.equal(prompted.status, 'completed', prompted.error);
      assert.equal(prompted.text.trim(), 'WITCH_PROMPT_505');
      await until(
        'native idle',
        () =>
          events.findLast((event) => event.type === 'running')?.running ===
          false,
        3000,
      );
    } else {
      await writeFile(
        join(options.cwd, 'probe.mjs'),
        `import {existsSync} from 'node:fs'; const timer = setInterval(() => { if (existsSync('emit')) { process.stdout.write(${JSON.stringify(familiarMarker({ version: 1, conversation: binding.conversation, activation: binding.activation, run }))}); clearInterval(timer); } }, 20); setTimeout(() => {}, 120000);\n`,
      );
      const result = await session.send(
        adapter.id === 'claude'
          ? 'Run exactly `node probe.mjs` with Bash run_in_background=true. Do not read files, load spells or delegate. Reply only WITCH_BACKGROUND_309 after starting it. Do not wait for it or stop it.'
          : 'Run exactly `node probe.mjs` with exec_command yield_time_ms=1000. Request native permission if needed. Do not read files, load spells or delegate. Reply only WITCH_BACKGROUND_309 after starting it. Do not wait for it or stop it.',
      );
      assert.equal(result.status, 'completed', result.error);
      assert.match(result.text, /WITCH_BACKGROUND_309/);
      await until(
        'native background membership',
        () =>
          events.some(
            (event) =>
              event.type === 'command' && event.command.status === 'running',
          ),
        1500,
      );
      await writeFile(join(options.cwd, 'emit'), 'emit');
      await until(
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
  } finally {
    await session.close();
  }
  return events;
}
