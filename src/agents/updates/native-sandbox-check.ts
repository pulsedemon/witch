import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { join } from 'node:path';
import { CodexAdapter } from '../codex/adapter.js';
import type { AgentSession } from '../types.js';
import { unlessGone, writeJson } from '../../persistence/json.js';
import { quote } from '../../shell.js';

export function streamResponse(
  response: ServerResponse,
  id: string,
  item: unknown,
): object[] {
  const messages = [
    { type: 'response.created', response: { id } },
    { type: 'response.output_item.done', output_index: 0, item },
    {
      type: 'response.completed',
      response: {
        id,
        status: 'completed',
        usage: {
          input_tokens: 10,
          output_tokens: 10,
          total_tokens: 20,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      },
    },
  ];

  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    Connection: 'close',
  });

  response.end(
    messages
      .map(
        (message) =>
          `event: ${message.type}\ndata: ${JSON.stringify(message)}\n\n`,
      )
      .join(''),
  );

  return messages;
}

/** a deterministic local model forces the real native tool to exercise the answer's sandbox. */
export async function checkCodexAnswerSandbox(
  executable: string,
  directory: string,
  signal: AbortSignal,
): Promise<void> {
  await checkProfile(executable, join(directory, 'builtin'), signal, false);
  await checkProfile(executable, join(directory, 'checkout'), signal, true);
}

async function checkProfile(
  executable: string,
  directory: string,
  signal: AbortSignal,
  named: boolean,
): Promise<void> {
  const config = join(directory, 'config');
  const cwd = join(directory, 'project');
  const temporary = join(directory, 'tmp');

  await Promise.all(
    [config, cwd, temporary].map((path) =>
      mkdir(path, { recursive: true, mode: 0o700 }),
    ),
  );

  const requestFile = join(directory, 'request.json');
  await writeFile(requestFile, '{"marker":"REQUEST_TOKEN"}');
  const sibling = join(directory, 'private-sibling');
  const denied = join(cwd, 'denied');
  await writeFile(sibling, 'PRIVATE_TOKEN');
  await writeFile(denied, 'DENIED_TOKEN');
  let phase: 'ordinary' | 'answer' | 'after' = 'ordinary';
  let failure: unknown;
  let session: AgentSession | undefined;
  const outputs: Record<string, string> = {};
  const calls = new Set<string>();

  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];

      for await (const chunk of request) chunks.push(Buffer.from(chunk));

      const body = JSON.parse(Buffer.concat(chunks).toString()) as {
        tools: { name?: string; type: string }[];
        input: { type?: string; call_id?: string; output?: string }[];
      };

      const callId = `native-update-${phase}`;

      const output = body.input.findLast(
        (item) =>
          item.type === 'function_call_output' && item.call_id === callId,
      );

      let item: Record<string, unknown>;

      if (!output) {
        assert.ok(
          !calls.has(phase),
          `Native tool never returned its ${phase} result`,
        );

        assert.ok(
          body.tools.some(
            (tool) => tool.type === 'function' && tool.name === 'exec_command',
          ),
          'Native exec_command was not advertised',
        );

        calls.add(phase);

        const script =
          phase === 'answer'
            ? [
                `if printf %s answer > ${quote(join(cwd, phase))}; then printf 'WRITE:ALLOWED\\n'; else printf 'WRITE:DENIED\\n'; fi`,
                ...(named
                  ? [
                      ['REQUEST', requestFile],
                      ['SIBLING', sibling],
                      ['DENIED', denied],
                    ].map(
                      ([label, path]) =>
                        `if probe_output=$(/bin/cat ${quote(path!)} 2>&1); then printf '%s\\n' ${quote(label! + ':')}"$probe_output"; else printf '%s\\n' ${quote(label! + ':DENIED:')}"$probe_output"; fi`,
                    )
                  : []),
              ].join('\n')
            : `printf %s ${quote(phase)} > ${quote(join(cwd, phase))}`;

        item = {
          type: 'function_call',
          id: `call-${phase}`,
          call_id: callId,
          name: 'exec_command',
          arguments: JSON.stringify({
            cmd: script,
          }),
        };
      } else {
        assert.equal(typeof output.output, 'string');
        outputs[phase] = output.output!;

        if (phase === 'answer') {
          assert.match(output.output!, /WRITE:DENIED/);

          assert.match(
            output.output!,
            /operation not permitted|permission denied|read-only file system/i,
          );

          if (named) {
            assert.match(output.output!, /REQUEST:.*REQUEST_TOKEN/);

            assert.match(
              output.output!,
              /SIBLING:DENIED:.*(?:operation not permitted|permission denied)/i,
            );

            assert.match(
              output.output!,
              /DENIED:DENIED:.*(?:operation not permitted|permission denied)/i,
            );

            assert.doesNotMatch(output.output!, /PRIVATE_TOKEN|DENIED_TOKEN/);
          }

          assert.equal(
            await unlessGone(readFile(join(cwd, phase))),
            undefined,
            'Restricted native tool wrote its target',
          );
        } else assert.equal(await readFile(join(cwd, phase), 'utf8'), phase);

        item = {
          type: 'message',
          role: 'assistant',
          id: `message-${phase}`,
          content: [
            {
              type: 'output_text',
              text: phase === 'answer' ? '{"result":"CHECKED"}' : 'OK',
              annotations: [],
            },
          ],
        };
      }

      const id = `response-${phase}-${output ? 'done' : 'tool'}`;
      streamResponse(response, id, item);
    })().catch((error) => {
      failure ??= error;
      response.writeHead(500);
      response.end('Native verification failed');
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });

    const address = server.address();
    assert.ok(address && typeof address !== 'string');

    await writeFile(
      join(config, 'config.toml'),
      `model="gpt-5.4"
model_provider="native_probe"
approval_policy="never"
${
  named
    ? `default_permissions="owner"
[permissions.base.filesystem]
":minimal"="read"
${JSON.stringify(cwd)}="write"
${JSON.stringify(denied)}="deny"
[permissions.owner]
extends="base"
[permissions.owner.network]
enabled=false
`
    : 'sandbox_mode="workspace-write"'
}
[projects.${JSON.stringify(cwd)}]
trust_level="trusted"
[model_providers.native_probe]
name="Local native verification"
base_url="http://127.0.0.1:${address.port}/v1"
wire_api="responses"
requires_openai_auth=false
supports_websockets=false
request_max_retries=0
`,
    );

    const adapter = new CodexAdapter((command, directory, childSignal) =>
      spawn(command, ['app-server', '--stdio'], {
        cwd: directory,
        signal: AbortSignal.any([
          signal,
          ...(childSignal ? [childSignal] : []),
        ]),
        stdio: 'pipe',
        env: {
          ...process.env,
          CODEX_HOME: config,
          TMPDIR: temporary,
          LC_ALL: 'C',
        },
      }),
    );

    session = await adapter.connect({
      executable,
      cwd,
      model: 'gpt-5.4',
      memoryDirectories: [],
      signal,
      onProcess: async () => {},
      onEvent: (event) => {
        if (event.type === 'request') {
          failure = new Error('Native sandbox verification asked for approval');
          session!.respond(event.request.id, { decision: 'decline' });
        }
      },
    });

    if (named)
      assert.equal(
        session.info.permissionProfile,
        'owner',
        'Native checkout profile was not selected',
      );

    for (const next of ['ordinary', 'answer', 'after'] as const) {
      phase = next;

      const result = await session.send(
        `Synthetic native boundary check ${phase}.`,
        {
          purpose: phase === 'answer' ? 'peer-answer' : 'user',
          answer:
            phase === 'answer'
              ? {
                  requestFile,
                  outputSchema: {
                    type: 'object',
                    properties: {
                      result: { type: 'string', enum: ['CHECKED'] },
                    },
                    required: ['result'],
                    additionalProperties: false,
                  },
                }
              : undefined,
        },
      );

      if (failure) throw failure;

      assert.equal(result.status, 'completed', result.error);
      assert.ok(phase in outputs, `No native ${phase} tool result`);
    }
  } catch (error) {
    failure ??= error;
  } finally {
    try {
      await session?.close();
    } catch (error) {
      failure ??= error;
    }

    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));

    await writeJson(join(directory, 'sandbox-evidence.json'), {
      outputs,
      error: failure instanceof Error ? failure.message : undefined,
    });
  }

  if (failure) throw failure;
}
