#!/usr/bin/env node
import process from 'node:process';
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';

const mode = process.argv[2];
const boundary = mode === 'app-server';
const directory = boundary ? dirname(process.env.CODEX_HOME) : undefined;

if (boundary)
  appendFileSync(join(directory, 'children.jsonl'), `${process.pid}\n`);

let threadId = 'qualification-thread';
let restricted = false;
let sequence = 0;
let turnId;
let pending;
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

const event = (method, params) =>
  send({ method, params: { threadId, turnId, ...params } });

const finish = (text = 'DONE', error) => {
  event('item/completed', {
    item: { id: `answer-${sequence}`, type: 'agentMessage', text },
  });

  event('turn/completed', {
    turn: {
      id: turnId,
      status: error ? 'failed' : 'completed',
      error: error ? { message: error } : null,
    },
  });
};

const commandEvent = (method, id, name) =>
  event(method, {
    item: {
      id,
      type: 'commandExecution',
      command: `node ${name}.mjs`,
      cwd: process.cwd(),
      status: method === 'item/started' ? 'inProgress' : 'completed',
      aggregatedOutput: '',
      exitCode: 0,
    },
  });

for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  const reply = (result) => send({ id: request.id, result });

  if (boundary) {
    if (
      ['thread/start', 'thread/resume', 'thread/fork'].includes(request.method)
    ) {
      restricted = request.params.ephemeral === true;
      threadId = restricted ? 'answer' : 'owner';

      reply({
        thread: { id: threadId },
        model: 'fixture',
        approvalPolicy: restricted ? 'never' : 'on-request',
        ...(restricted && {
          sandbox: { type: 'readOnly', networkAccess: false },
        }),
        approvalsReviewer: 'user',
        reasoningEffort: 'low',
      });
    } else if (request.method === 'config/read')
      reply({ config: { mcp_servers: {} } });
    else if (request.method === 'mcpServerStatus/list')
      reply({ data: [], nextCursor: null });
    else if (request.method === 'turn/start') {
      turnId = `turn-${++sequence}`;
      reply({ turn: { id: turnId, status: 'inProgress' } });
      event('turn/started', { turn: { id: turnId, status: 'inProgress' } });

      if (restricted)
        writeFileSync(join(directory, 'answer-started'), String(process.pid));
      else {
        const settings = join(process.env.CODEX_HOME, 'config.toml');

        if (existsSync(settings)) {
          const url = /base_url="([^"]+)"/.exec(
            readFileSync(settings, 'utf8'),
          )[1];

          const post = async (input) =>
            (
              await globalThis.fetch(`${url}/responses`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  tools: [{ name: 'exec_command', type: 'function' }],
                  input,
                }),
              })
            ).text();

          const frames = (await post([]))
            .split('\n')
            .filter((line) => line.startsWith('data: '))
            .map((line) => JSON.parse(line.slice(6)));

          const call = frames.find(
            (frame) => frame.type === 'response.output_item.done',
          ).item;

          writeFileSync('ordinary', 'ordinary');

          await post([
            {
              type: 'function_call_output',
              call_id: call.call_id,
              output: 'local fixture completed',
            },
          ]);
        } else appendFileSync(join(directory, 'mcp-writes'), 'MCP_WRITE\n');

        finish();
      }
    } else if (request.id !== undefined) reply({});

    continue;
  }

  if (!request.method) {
    if (pending && request.id === 'permission') {
      if (request.result.decision === 'accept' || mode === 'declined-write')
        writeFileSync(pending.name, pending.name);

      if (mode === 'extra-tool')
        commandEvent('item/completed', 'unexpected-tool', 'unexpected');

      commandEvent('item/completed', pending.id, pending.name);
      pending = undefined;
      finish();
    }

    continue;
  }

  if (request.method === 'model/list') {
    reply({
      data: [
        {
          id: 'fixture',
          displayName: 'Fixture',
          supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
        },
      ],
      nextCursor: null,
    });
  } else if (
    request.method === 'thread/start' ||
    request.method === 'thread/resume'
  ) {
    reply({
      thread: { id: threadId },
      model: 'fixture',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      reasoningEffort: 'low',
    });
  } else if (request.method === 'thread/compact/start') {
    reply({});
    turnId = `turn-${++sequence}`;
    event('turn/started', { turn: { id: turnId, status: 'inProgress' } });

    for (const method of ['item/started', 'item/completed'])
      event(method, { item: { id: 'compact', type: 'contextCompaction' } });

    finish();
  } else if (request.method === 'turn/start') {
    turnId = `turn-${++sequence}`;
    reply({ turn: { id: turnId, status: 'inProgress' } });
    event('turn/started', { turn: { id: turnId, status: 'inProgress' } });

    const prompt = request.params.input
      .map((item) => item.text ?? '')
      .join('\n');

    const marker = /WITCH_RESUME_[a-f0-9]+/.exec(prompt)?.[0];

    if (marker) {
      writeFileSync(join(process.env.CODEX_HOME, 'remembered-marker'), marker);
      finish(marker);
    } else if (prompt.includes('before compaction')) {
      if (mode === 'lost-context') finish('WRONG_CONTEXT');
      else if (mode === 'exhausted') finish('', 'Usage limit reached');
      else if (mode === 'timeout') writeFileSync('waiting', 'ready');
      else
        finish(
          readFileSync(
            join(process.env.CODEX_HOME, 'remembered-marker'),
            'utf8',
          ),
        );
    } else if (prompt.includes('native approval')) {
      const name = /node (approved-result|declined-result)\.mjs/.exec(
        prompt,
      )[1];

      const id = `tool-${sequence}`;
      commandEvent('item/started', id, name);

      if (mode === 'bypass') {
        writeFileSync(name, name);
        commandEvent('item/completed', id, name);
        finish();
      } else {
        pending = { id, name };

        send({
          id: 'permission',
          method: 'item/commandExecution/requestApproval',
          params: {
            threadId,
            turnId,
            itemId: id,
            command: `node ${mode === 'other-command' ? 'other' : name}.mjs`,
            cwd: process.cwd(),
          },
        });
      }
    } else finish('UNEXPECTED_PROMPT');
  } else if (request.id !== undefined) reply({});
}
