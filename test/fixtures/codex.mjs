import process from 'node:process';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

let model = 'model-a';
let effort = 'low';
let hasHistory = false;
const lines = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const notify = (method, params) => send({ method, params });
const file = (name) => join(process.cwd(), name);
const session = () => ({
  thread: { id: 'native-thread' },
  model,
  cwd: process.cwd(),
  approvalPolicy: 'on-request',
  approvalsReviewer: 'user',
  reasoningEffort: effort,
});
const finish = (status, error = null) =>
  notify('turn/completed', {
    threadId: 'native-thread',
    turn: { id: 'turn-1', status, error },
  });
// a held event waits for the test's release file after its reply is out
const held = async () => {
  writeFileSync(file('replied'), 'yes');
  while (!existsSync(file('release'))) await delay(5);
};
let prompt = '';
for await (const line of lines) {
  const request = JSON.parse(line);
  const reply = (result) => send({ id: request.id, result });
  if (request.method === 'initialize') reply({ userAgent: 'fixture' });
  if (request.method === 'config/read')
    reply({
      config: {
        sandbox_workspace_write: { writable_roots: ['/already-allowed'] },
      },
    });
  if (request.method === 'model/list') {
    const second = request.params.cursor === 'page-2';
    reply({
      data: [
        {
          id: second ? 'model-b' : 'model-a',
          model: second ? 'model-b' : 'model-a',
          displayName: second ? 'B' : 'A',
          description: 'fixture',
          supportedReasoningEfforts: [
            { reasoningEffort: second ? 'high' : 'low' },
          ],
        },
      ],
      nextCursor: second ? null : 'page-2',
    });
  }
  if (request.method === 'thread/start' || request.method === 'thread/resume') {
    if (request.method === 'thread/resume' && !hasHistory) {
      send({
        id: request.id,
        error: { message: 'no rollout found for thread id native-thread' },
      });
      continue;
    }
    writeFileSync(file('start.json'), JSON.stringify(request));
    model = request.params.model ?? model;
    reply(session());
  }
  if (request.method === 'thread/settings/update') {
    model = request.params.model;
    // the server can't clear effort, so an omitted one stays in force
    effort = request.params.effort ?? effort;
    reply({});
    if (model === 'held') await held();
    notify('thread/settings/updated', {
      threadId: 'native-thread',
      threadSettings:
        model === 'bad-settings' ? { model: 5 } : { model, effort },
    });
  }
  if (request.method === 'turn/start') {
    hasHistory = true;
    prompt = request.params.input[0].text;
    writeFileSync(file('prompt.json'), JSON.stringify(request));
    reply({ turn: { id: 'turn-1' } });
    if (prompt === 'wait' || prompt === 'hold') continue;
    if (prompt === 'malformed') {
      for (let count = 0; count < 2; count++)
        notify('item/agentMessage/delta', { itemId: 7, delta: 'bad' });
      finish('completed');
      continue;
    }
    if (prompt === 'null-turn') {
      notify('turn/completed', { threadId: 'native-thread', turn: null });
      continue;
    }
    if (prompt === 'in-progress') {
      finish('inProgress');
      continue;
    }
    if (prompt === 'failed') {
      finish('failed', { message: 'native failure' });
      continue;
    }
    if (prompt === 'bad-request') {
      send({
        id: 90,
        method: 'item/tool/requestUserInput',
        params: { questions: 'not a list' },
      });
      continue;
    }
    if (prompt === 'grandchild') {
      const grandchild = spawn('/bin/sleep', ['3'], {
        stdio: ['ignore', 'inherit', 'inherit'],
      });
      writeFileSync(file('grandchild.pid'), String(grandchild.pid));
      process.exit(1);
    }
    if (prompt === 'question') {
      send({
        id: 88,
        method: 'item/tool/requestUserInput',
        params: {
          questions: [
            {
              id: 'value',
              header: 'Value',
              question: 'Private value?',
              isOther: false,
              isSecret: true,
              options: null,
            },
          ],
        },
      });
      continue;
    }
    if (prompt === 'elicitation') {
      send({
        id: 89,
        method: 'mcpServer/elicitation/request',
        params: {
          message: 'Provide a label',
          requestedSchema: {
            type: 'object',
            properties: { label: { type: 'string' } },
          },
        },
      });
      continue;
    }
    send({
      id: 77,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'native-thread',
        turnId: 'turn-1',
        itemId: 'tool-1',
        command: 'write approved.txt',
        cwd: process.cwd(),
      },
    });
  }
  if (request.id === 77 && request.result) {
    if (request.result.decision === 'accept')
      writeFileSync(file('approved.txt'), 'approved');
    notify('item/agentMessage/delta', {
      itemId: 'message-1',
      delta: 'Finished.',
    });
    notify('item/completed', {
      item: { type: 'agentMessage', id: 'message-1', text: 'Finished.' },
    });
    finish('completed');
  }
  if ((request.id === 88 || request.id === 89) && request.result) {
    writeFileSync(
      file(`response-${request.id}.json`),
      JSON.stringify(request.result),
    );
    finish('completed');
  }
  if (request.id === 90 && request.error) {
    writeFileSync(file('error-90.json'), JSON.stringify(request.error));
    finish('completed');
  }
  if (request.method === 'turn/interrupt') {
    if (prompt === 'hold') {
      reply({});
      await held();
      finish('interrupted');
    } else {
      finish('interrupted');
      reply({});
    }
  }
}
