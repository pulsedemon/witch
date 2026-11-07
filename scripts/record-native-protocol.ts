import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { verificationAdapter } from '../src/agents/native-verification-profile.js';
import { observeWire, normalizeWire } from '../test/fixtures/native-wire.js';
import { nativeScenario } from '../src/agents/native-scenario.js';

const { values } = parseArgs({
  options: {
    runtime: { type: 'string' },
    executable: { type: 'string' },
    out: { type: 'string' },
    model: { type: 'string' },
    scenario: { type: 'string', default: 'basic' },
  },
});
assert.ok(
  values.runtime === 'codex' || values.runtime === 'claude',
  '--runtime codex|claude is required',
);
assert.ok(values.out && values.model, '--out and --model are required');
assert.ok(
  values.scenario === 'basic' ||
    values.scenario === 'control' ||
    values.scenario === 'background' ||
    values.scenario === 'spell' ||
    values.scenario === 'idle-run',
  'Unknown scenario',
);
const root = resolve(values.out);
await mkdir(root);
const cwd = join(root, 'project');
await mkdir(cwd);
const instructions = `This is a synthetic protocol check. ${
  values.scenario === 'spell'
    ? 'Perform only the exact prompt. You may run the probe-spell skill and launch one subagent when asked.'
    : 'Perform only the exact prompt. Do not load skills or delegate.'
}\n`;
await writeFile(join(cwd, 'AGENTS.md'), instructions);
await writeFile(join(cwd, 'CLAUDE.md'), instructions);
if (values.scenario === 'spell') {
  for (const skills of ['.claude/skills', '.agents/skills']) {
    await mkdir(join(cwd, skills, 'probe-spell'), { recursive: true });
    await writeFile(
      join(cwd, skills, 'probe-spell', 'SKILL.md'),
      '---\nname: probe-spell\ndescription: Answers a protocol probe. Use when asked to run the probe spell.\n---\n\nReply with exactly `PROBE CAST` followed by any arguments you were given, and nothing else.\n',
    );
  }
  execFileSync('git', ['init', '-q'], { cwd });
}
process.env.CLAUDE_CODE_TMPDIR = root;
const captures: ReturnType<typeof observeWire>[] = [];
const launches: { command: string; args: string[] }[] = [];
const start = (
  command: string,
  args: string[],
  directory: string,
  env = process.env,
  signal?: AbortSignal,
) => {
  const child = spawn(command, args, {
    cwd: directory,
    env,
    signal,
    stdio: 'pipe',
  });
  launches.push({ command, args });
  captures.push(observeWire(child));
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  return child;
};
const executable = values.executable ?? values.runtime;
const adapter = await verificationAdapter(values.runtime, root, start);
let passed = false;
const abort = new AbortController();
const timeout = setTimeout(
  () => abort.abort(new Error('Native capture exceeded five minutes')),
  300000,
);
try {
  await nativeScenario(
    adapter,
    {
      cwd,
      executable,
      model: values.model,
      effort: 'low',
      memoryDirectories: [],
      signal: abort.signal,
    },
    values.scenario,
    (event) => {
      if (event.type === 'notice') console.error(event.text);
      if (event.type === 'tool') console.error('tool', event.title, event.done);
      if (event.type === 'compacted') console.error('compacted');
    },
    true,
  );
  if (values.scenario === 'background') {
    const frames = captures
      .flatMap((capture) => capture.frames)
      .map((frame) => frame.message) as Record<string, unknown>[];
    if (values.runtime === 'codex') {
      const request = frames.find(
        (frame) => frame.method === 'thread/backgroundTerminals/terminate',
      );
      assert.ok(request, 'Native terminal cleanup was requested');
      const response = frames.find(
        (frame) => frame.id === request.id && frame.result,
      );
      assert.equal(
        (response?.result as { terminated?: boolean })?.terminated,
        true,
      );
    } else {
      const request = frames.find(
        (frame) =>
          (frame.request as { subtype?: string })?.subtype === 'stop_task',
      );
      assert.ok(request, 'Native task cleanup was requested');
      const response = frames.find(
        (frame) =>
          (frame.response as { request_id?: string })?.request_id ===
          request.request_id,
      );
      assert.equal(
        (response?.response as { subtype?: string })?.subtype,
        'success',
      );
    }
  }
  passed = true;
} finally {
  clearTimeout(timeout);
  await Promise.all(captures.map((capture) => capture.finished()));
  for (const [index, capture] of captures.entries()) {
    await writeFile(
      join(root, `${index}.jsonl`),
      capture.frames.map((frame) => JSON.stringify(frame)).join('\n') + '\n',
    );
  }
  await writeFile(
    join(root, 'capture.json'),
    JSON.stringify(
      {
        runtime: values.runtime,
        version: execFileSync(executable, ['--version'], {
          encoding: 'utf8',
        }).trim(),
        model: values.model,
        scenario: values.scenario,
        passed,
        cwd,
        launches,
      },
      null,
      2,
    ) + '\n',
  );
  if (passed) {
    const normalized = join(root, 'normalized');
    await mkdir(normalized);
    for (const [index, capture] of captures.entries()) {
      await writeFile(
        join(normalized, `${values.scenario}-${index}.jsonl`),
        capture.frames
          .map((frame) => JSON.stringify(normalizeWire(frame, cwd, homedir())))
          .join('\n') + '\n',
      );
    }
  }
  console.error(
    JSON.stringify({
      passed,
      streams: captures.map((capture) => capture.frames.length),
      root,
    }),
  );
}
