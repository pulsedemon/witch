import { setInterval, clearInterval } from 'node:timers';
import process from 'node:process';
import readline from 'node:readline';
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const lines = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const session_id = randomUUID();
let initialization = 0;
let model = 'claude-a';
let lastPrompt = '';
const state = (state) =>
  send({
    type: 'system',
    subtype: 'session_state_changed',
    state,
    uuid: randomUUID(),
    session_id,
  });
const result = () =>
  send({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Finished.',
    uuid: randomUUID(),
    session_id,
    num_turns: 1,
    duration_ms: 1,
    duration_api_ms: 1,
    usage: {},
    modelUsage: {},
    permission_denials: [],
    total_cost_usd: 0,
  });
const finish = () => {
  result();
  if (lastPrompt === 'wait for idle') {
    const interval = setInterval(() => {
      if (existsSync(join(process.cwd(), 'allow-idle'))) {
        clearInterval(interval);
        state('idle');
      }
    }, 5);
  } else state('idle');
};
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.type === 'control_request') {
    const request = message.request;
    let response = {};
    if (request.subtype === 'initialize') {
      initialization++;
      writeFileSync(
        join(process.cwd(), 'initialize.json'),
        JSON.stringify(request),
      );
      response = {
        commands: [],
        agents: [],
        output_style: 'default',
        available_output_styles: [],
        account: {},
        models: [
          {
            value: initialization === 1 ? 'claude-a' : 'claude-b',
            displayName: 'Claude fixture',
            description: 'fixture',
            supportsEffort: true,
            supportedEffortLevels: ['low', 'high'],
          },
        ],
      };
    }
    if (request.subtype === 'set_model') model = request.model;
    if (request.subtype === 'apply_flag_settings')
      writeFileSync(
        join(process.cwd(), 'settings.json'),
        JSON.stringify(request.settings),
      );
    if (request.subtype === 'interrupt') {
      result();
      state('idle');
    }
    send({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: message.request_id,
        response,
      },
    });
  } else if (message.type === 'user') {
    lastPrompt = message.message.content;
    writeFileSync(join(process.cwd(), 'prompt.txt'), lastPrompt);
    send({
      type: 'system',
      subtype: 'init',
      model,
      permissionMode: 'default',
      cwd: process.cwd(),
      session_id,
      tools: [],
      mcp_servers: [],
      slash_commands: [],
      apiKeySource: 'none',
      output_style: 'default',
      agents: [],
      skills: [],
      plugins: [],
      uuid: randomUUID(),
      claude_code_version: '2.1.296',
    });
    state('running');
    if (lastPrompt === 'approval')
      send({
        type: 'control_request',
        request_id: 'permit-1',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'Write',
          input: {
            file_path: join(process.cwd(), 'approved.txt'),
            content: 'accepted',
          },
          tool_use_id: 'tool-1',
        },
      });
    else if (lastPrompt !== 'wait') finish();
  } else if (
    message.type === 'control_response' &&
    message.response.request_id === 'permit-1'
  ) {
    if (message.response.response.behavior === 'allow')
      writeFileSync(
        join(process.cwd(), 'approved.txt'),
        message.response.response.updatedInput.content,
      );
    finish();
  }
}
