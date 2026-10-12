import { setInterval, clearInterval } from 'node:timers';
import process from 'node:process';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// modes that a prompt can't reach come from the command line
const mode = process.argv[2] ?? '';
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
const assistant = (text) =>
  send({
    type: 'assistant',
    uuid: randomUUID(),
    session_id,
    parent_tool_use_id: null,
    message: {
      id: randomUUID(),
      type: 'message',
      role: 'assistant',
      model,
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
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
/** exits once a grandchild sharing stderr is running; it writes a line about 65 ms later. */
const exitBeforeGrandchild = (code) => {
  const grandchild = spawn(
    '/bin/sh',
    ['-c', 'printf r >&4; cat <&3; sleep 0.05; echo grandchild line >&2'],
    { stdio: ['ignore', 'ignore', 'inherit', 'pipe', 'pipe'] },
  );
  grandchild.stdio[4].once('data', () =>
    process.stderr.write('fixture stderr text\n', () => process.exit(code)),
  );
};
const finish = () => {
  result();
  if (lastPrompt === 'wait for idle') {
    const states = ['running', 'requires_action', 'idle'];
    const interval = setInterval(() => {
      const next = states[0];
      if (!existsSync(join(process.cwd(), `allow-${next}`))) return;
      states.shift();
      state(next);
      if (next === 'idle') clearInterval(interval);
      else assistant(next);
    }, 5);
  } else {
    state('idle');
    if (mode === 'exit-when-idle') exitBeforeGrandchild(1);
  }
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
      if (mode === 'init-error') {
        process.stderr.write('init failed text\n');
        send({
          type: 'control_response',
          response: {
            subtype: 'error',
            request_id: message.request_id,
            error: 'initialize refused',
          },
        });
        continue;
      }
      response = {
        // a built-in, a user command its name shadows, and a skill
        commands: [
          {
            name: 'compact',
            description: 'Compact the conversation',
            argumentHint: '',
            builtin: true,
          },
          { name: 'compact', description: 'Shadowed', argumentHint: '' },
          {
            name: 'review',
            description: 'Review changes',
            argumentHint: '<target>',
          },
        ],
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
    if (request.subtype === 'apply_flag_settings') {
      writeFileSync(
        join(process.cwd(), 'settings.json'),
        JSON.stringify(request.settings),
      );
      appendFileSync(
        join(process.cwd(), 'settings.jsonl'),
        `${JSON.stringify(request.settings)}\n`,
      );
    }
    if (request.subtype === 'interrupt') {
      if (lastPrompt === 'still queued') response = { still_queued: ['q-1'] };
      else {
        result();
        state('idle');
      }
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
    writeFileSync(
      join(process.cwd(), 'content.json'),
      JSON.stringify(lastPrompt),
    );
    if (typeof lastPrompt === 'string')
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
    else if (lastPrompt === 'question')
      send({
        type: 'control_request',
        request_id: 'permit-1',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'AskUserQuestion',
          input: {
            questions: [
              {
                question: 'Colors?',
                header: 'Colors',
                multiSelect: true,
                options: [
                  { label: 'red' },
                  { label: 'green' },
                  { label: 'blue' },
                ],
              },
            ],
          },
          tool_use_id: 'tool-1',
        },
      });
    else if (lastPrompt === 'elicit')
      send({
        type: 'control_request',
        request_id: 'elicit-1',
        request: {
          subtype: 'elicitation',
          mcp_server_name: 'tracker',
          message: 'Which project?',
          requested_schema: {
            type: 'object',
            properties: { project: { type: 'string' } },
          },
        },
      });
    else if (['wait', 'still queued'].includes(lastPrompt))
      assistant('Working.');
    else if (lastPrompt === 'crash') {
      assistant('Working.');
      exitBeforeGrandchild(1);
    } else if (lastPrompt === 'die') {
      assistant('Working.');
      // holds stdout, so the SDK's read loop outlives the exit
      spawn('/bin/sleep', ['1'], { stdio: ['ignore', 'inherit', 'ignore'] });
      process.exit(1);
    } else if (lastPrompt === 'quit early')
      process.stderr.write('quitting early\n', () => process.exit(0));
    else if (lastPrompt === 'add skill') {
      send({
        type: 'system',
        subtype: 'commands_changed',
        commands: [
          {
            name: 'clear',
            description: 'Clear',
            argumentHint: '',
            builtin: true,
          },
          { name: 'later', description: 'Added later', argumentHint: '' },
        ],
        uuid: randomUUID(),
        session_id,
      });
      finish();
    } else finish();
  } else if (
    message.type === 'control_response' &&
    ['permit-1', 'elicit-1'].includes(message.response.request_id)
  ) {
    const { response } = message.response;
    if (lastPrompt !== 'approval')
      writeFileSync(
        join(process.cwd(), 'response.json'),
        JSON.stringify(response),
      );
    else if (response.behavior === 'allow')
      writeFileSync(
        join(process.cwd(), 'approved.txt'),
        response.updatedInput.content,
      );
    finish();
  }
}
