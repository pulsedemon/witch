import process from 'node:process';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// modes that a prompt can't reach come from the command line
const mode = process.argv[2] ?? '';
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
let skillAdded = false;
const skill = (name, fields) => ({
  name,
  path: `/skills/${name}/SKILL.md`,
  enabled: true,
  ...fields,
});
for await (const line of lines) {
  const request = JSON.parse(line);
  const reply = (result) => send({ id: request.id, result });
  if (request.method === 'initialize') {
    if (mode === 'exit-on-init')
      process.stderr.write('init exit text\n', () => process.exit(1));
    else reply({ userAgent: 'fixture' });
  }
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
  if (request.method === 'skills/list') {
    writeFileSync(file('skills.json'), JSON.stringify(request));
    reply({
      data: [
        {
          cwd: process.cwd(),
          errors: [],
          skills: [
            skill('review', {
              description: 'review description',
              shortDescription: 'review short',
              interface: { shortDescription: 'review interface' },
            }),
            skill('off', { description: 'disabled', enabled: false }),
            skill('legacy', {
              description: 'legacy description',
              shortDescription: 'legacy short',
            }),
            { ...skill('review', { description: 'duplicate' }), path: '/x' },
            skill('bare', { description: 'bare description' }),
            ...(skillAdded
              ? [skill('later', { description: 'added later' })]
              : []),
          ],
        },
      ],
    });
  }
  if (request.method === 'thread/start' || request.method === 'thread/resume') {
    if (request.method === 'thread/resume' && !hasHistory) {
      send({
        id: request.id,
        error: {
          message: `no rollout found for thread id ${request.params.threadId}`,
        },
      });
      continue;
    }
    writeFileSync(file('start.json'), JSON.stringify(request));
    model = request.params.model ?? model;
    reply(session());
  }
  if (request.method === 'thread/settings/update') {
    const previous = `${model}/${effort}`;
    model = request.params.model;
    // the server can't clear effort, so an omitted one stays in force
    effort = request.params.effort ?? effort;
    reply({});
    if (model === 'held') await held();
    // as Codex does, only a change is notified
    if (`${model}/${effort}` !== previous)
      notify('thread/settings/updated', {
        threadId: 'native-thread',
        threadSettings:
          model === 'bad-settings' ? { model: 5 } : { model, effort },
      });
  }
  if (request.method === 'turn/start') {
    hasHistory = true;
    const prompt = request.params.input[0].text;
    writeFileSync(file('prompt.json'), JSON.stringify(request));
    reply({ turn: { id: 'turn-1' } });
    if (prompt === 'hold') continue;
    if (prompt === 'add skill') {
      skillAdded = true;
      notify('skills/changed', {});
      finish('completed');
      continue;
    }
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
    if (prompt === 'reroute') {
      notify('model/rerouted', {
        threadId: 'native-thread',
        turnId: 'turn-1',
        fromModel: model,
        toModel: 'model-c',
        reason: 'highRiskCyberActivity',
      });
      finish('completed');
      continue;
    }
    if (prompt === 'error') {
      notify('error', {
        threadId: 'native-thread',
        turnId: 'turn-1',
        willRetry: false,
        error: {
          message: 'native error',
          codexErrorInfo: null,
          additionalDetails: null,
        },
      });
      finish('completed');
      continue;
    }
    if (prompt === 'tool') {
      const item = {
        type: 'commandExecution',
        id: 'cmd-1',
        command: 'ls',
        cwd: '/elsewhere',
      };
      notify('item/started', {
        item: { type: 'userMessage', id: 'user-1', content: [] },
      });
      notify('item/completed', {
        item: {
          type: 'reasoning',
          id: 'reasoning-1',
          summary: [],
          content: [],
        },
      });
      notify('item/started', { item: { ...item, aggregatedOutput: '' } });
      notify('item/commandExecution/outputDelta', {
        itemId: 'cmd-1',
        delta: 'a.md\n',
      });
      notify('item/completed', {
        item: { ...item, aggregatedOutput: 'a.md\n' },
      });
      finish('completed');
      continue;
    }
    if (prompt === 'unknown-request') {
      send({ id: 92, method: 'item/unknown/request', params: {} });
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
    if (prompt === 'permissions') {
      send({
        id: 91,
        method: 'item/permissions/requestApproval',
        params: {
          threadId: 'native-thread',
          turnId: 'turn-1',
          itemId: 'tool-1',
          permissions: { network: { enabled: true }, fileSystem: null },
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
  if ([88, 89, 91].includes(request.id) && request.result) {
    writeFileSync(
      file(`response-${request.id}.json`),
      JSON.stringify(request.result),
    );
    finish('completed');
  }
  if ([90, 92].includes(request.id) && request.error) {
    writeFileSync(
      file(`error-${request.id}.json`),
      JSON.stringify(request.error),
    );
    finish('completed');
  }
  if (request.method === 'turn/interrupt') {
    reply({});
    await held();
    finish('interrupted');
  }
}
