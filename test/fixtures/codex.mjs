import process from 'node:process';
import readline from 'node:readline';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

let model = 'model-a';
let hasHistory = false;
const lines = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const notify = (method, params) => send({ method, params });
const session = () => ({
  thread: { id: 'native-thread' },
  model,
  cwd: process.cwd(),
  approvalPolicy: 'on-request',
  approvalsReviewer: 'user',
});
const finish = (status) =>
  notify('turn/completed', {
    threadId: 'native-thread',
    turn: { id: 'turn-1', status, error: null },
  });
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
    writeFileSync(join(process.cwd(), 'start.json'), JSON.stringify(request));
    model = request.params.model ?? model;
    reply(session());
  }
  if (request.method === 'thread/settings/update') {
    model = request.params.model;
    notify('thread/settings/updated', {
      threadId: 'native-thread',
      threadSettings: { model, effort: request.params.effort ?? null },
    });
    reply({});
  }
  if (request.method === 'turn/start') {
    hasHistory = true;
    writeFileSync(join(process.cwd(), 'prompt.json'), JSON.stringify(request));
    reply({ turn: { id: 'turn-1' } });
    if (request.params.input[0].text === 'wait') continue;
    if (request.params.input[0].text === 'question') {
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
    if (request.params.input[0].text === 'elicitation') {
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
      writeFileSync(join(process.cwd(), 'approved.txt'), 'approved');
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
      join(process.cwd(), `response-${request.id}.json`),
      JSON.stringify(request.result),
    );
    finish('completed');
  }
  if (request.method === 'turn/interrupt') {
    finish('interrupted');
    reply({});
  }
}
