import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  observeWire,
  replayWire,
  normalizeWire,
} from './fixtures/native-wire.js';
import { scratch } from './fixtures/scratch.js';
import { probeApproval } from './fixtures/native-scenario.js';

test('wire capture retains split JSON lines in both directions without consuming the streams', async () => {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `
    process.stdin.on('data', (data) => {
      process.stdout.write(data.subarray(0, 4));
      process.stdout.write(data.subarray(4));
    });
    process.stdin.on('end', () => process.exit());
  `,
    ],
    { stdio: 'pipe' },
  );
  const capture = observeWire(child);
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += String(chunk);
  });
  child.stdin.write('{"id":');
  child.stdin.write('17,"text":"a\\nb"}\n');
  await new Promise<void>((resolve) => {
    child.stdout.on('data', () => {
      if (output.endsWith('\n')) resolve();
    });
  });
  child.stdin.end();
  await capture.finished();
  assert.equal(output, '{"id":17,"text":"a\\nb"}\n');
  assert.deepEqual(capture.frames, [
    { direction: 'client', message: { id: 17, text: 'a\nb' } },
    { direction: 'server', message: { id: 17, text: 'a\nb' } },
  ]);
});

test('capture normalization removes account identity and encoded project paths without changing protocol values', () => {
  const input = [
    {
      direction: 'server',
      message: {
        type: 'control_response',
        response: {
          request_id: 'request-a',
          response: {
            account: {
              email: 'private@example.com',
              organization: 'private organization',
            },
          },
        },
      },
    },
    {
      direction: 'server',
      message: {
        id: 17,
        result: {
          accountId: 'private-account',
          count: 17,
          missing: null,
          output_file:
            '/Users/person/project/-Users-person-project/tasks/output',
        },
      },
    },
    {
      direction: 'server',
      message: {
        method: 'remoteControl/status/changed',
        params: {
          serverName: 'personal-machine.local',
          installationId: 'personal-installation',
        },
      },
    },
  ];
  assert.deepEqual(
    normalizeWire(input, '/Users/person/project', '/Users/person'),
    [
      {
        direction: 'server',
        message: {
          type: 'control_response',
          response: {
            request_id: 'request-a',
            response: {
              account: {
                email: 'native@example.invalid',
                organization: 'native account',
              },
            },
          },
        },
      },
      {
        direction: 'server',
        message: {
          id: 17,
          result: {
            accountId: 'native-account',
            count: 17,
            missing: null,
            output_file: '/native/project/-native-project/tasks/output',
          },
        },
      },
      {
        direction: 'server',
        message: {
          method: 'remoteControl/status/changed',
          params: {
            serverName: 'native-machine.invalid',
            installationId: 'native-installation',
          },
        },
      },
    ],
  );
  assert.equal(input[1]!.message.result!.accountId, 'private-account');
});

test('replay binds request IDs consistently and rejects a changed payload', async () => {
  const cwd = await scratch('witch-native-wire-');
  const file = join(cwd, 'wire.jsonl');
  await writeFile(
    file,
    [
      {
        direction: 'client',
        message: { id: 1, method: 'probe', params: { value: 'first' } },
      },
      {
        direction: 'server',
        message: { id: 1, result: { count: 1, text: 'reply' } },
      },
      {
        direction: 'client',
        message: { id: 2, method: 'probe', params: { value: 'second' } },
      },
      { direction: 'server', message: { id: 2, result: 'done' } },
    ]
      .map((frame) => JSON.stringify(frame))
      .join('\n') + '\n',
  );
  const replay = replayWire([file], cwd);
  const child = replay.launch();
  const capture = observeWire(child);
  child.stdin.write(
    JSON.stringify({ id: 41, method: 'probe', params: { value: 'first' } }) +
      '\n',
  );
  await new Promise<void>((resolve) =>
    child.stdout.once('data', () => resolve()),
  );
  child.stdin.write(
    JSON.stringify({ id: 73, method: 'probe', params: { value: 'wrong' } }) +
      '\n',
  );
  await assert.rejects(replay.finished(), /frame 2/);
  await capture.finished();
  assert.deepEqual(
    capture.frames.filter(({ direction }) => direction === 'server'),
    [
      {
        direction: 'server',
        message: { id: 41, result: { count: 1, text: 'reply' } },
      },
    ],
  );
});

for (const [name, issued, expected, actual] of [
  [
    'thread reference',
    { method: 'thread/started', params: { thread: { id: 'native-thread' } } },
    { id: 1, method: 'turn/start', params: { threadId: 'native-thread' } },
    { id: 41, method: 'turn/start', params: { threadId: 'wrong-thread' } },
  ],
  [
    'approval response',
    { id: 0, method: 'item/commandExecution/requestApproval', params: {} },
    { id: 0, result: { decision: 'accept' } },
    { id: 99, result: { decision: 'accept' } },
  ],
] as const) {
  test(`replay rejects a wrong server-issued ${name} on its first use`, async () => {
    const cwd = await scratch('witch-native-issued-id-');
    const file = join(cwd, 'wire.jsonl');
    await writeFile(
      file,
      [
        { direction: 'server', message: issued },
        { direction: 'client', message: expected },
      ]
        .map((frame) => JSON.stringify(frame))
        .join('\n') + '\n',
    );
    const replay = replayWire([file], cwd);
    const child = replay.launch();
    await new Promise<void>((resolve) =>
      child.stdout.once('data', () => resolve()),
    );
    child.stdin.end(JSON.stringify(actual) + '\n');
    await assert.rejects(replay.finished(), /ID mismatch/);
  });
}

test('closing replay with a missing client request fails instead of accepting a partial recording', async () => {
  const cwd = await scratch('witch-native-incomplete-');
  const file = join(cwd, 'wire.jsonl');
  await writeFile(
    file,
    JSON.stringify({
      direction: 'client',
      message: { id: 1, method: 'required', params: {} },
    }) + '\n',
  );
  const replay = replayWire([file], cwd);
  replay.launch().stdin.end();
  await assert.rejects(replay.finished(), /Unconsumed native trace \(0\/1\)/);
});

test('native capture approves only its exact probe command', () => {
  const request = {
    id: 'probe',
    kind: 'approval' as const,
    title: 'command',
    detail: JSON.stringify({ command: 'node probe.mjs; touch unrelated' }),
  };
  assert.throws(() => probeApproval(request), /Unexpected capture command/);
  for (const command of ['node probe.mjs', "/bin/zsh -lc 'node probe.mjs'"]) {
    assert.deepEqual(
      probeApproval({ ...request, detail: JSON.stringify({ command }) }),
      { decision: 'accept' },
    );
  }
});
