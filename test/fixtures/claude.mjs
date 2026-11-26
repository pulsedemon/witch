import { turns } from './claude-turns.mjs';
import { peerAnswer } from './peer-answer.mjs';
import { setInterval, clearInterval, setTimeout } from 'node:timers';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import {
  appendFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { URL } from 'node:url';

// modes that a prompt can't reach come from the command line
const mode = process.argv[2] ?? '';
const sessionState = !process.argv.includes('--no-session-state');

if (mode === 'ignore-term') {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
}

const mcpServers = () =>
  mode === 'mcp'
    ? JSON.parse(readFileSync(join(process.cwd(), 'mcp-status.json'), 'utf8'))
    : [];

const lines = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const session_id = randomUUID();

const nativeVersion = JSON.parse(
  readFileSync(new URL('./native/manifest.json', import.meta.url), 'utf8'),
).claude.version;

const stateCommands = [
  ['autocompact', []],
  ['config', ['settings']],
  ['output-style', []],
  ['rename', ['name']],
  ['clear', ['reset', 'new']],
  ['advisor', []],
  ['auto-mode-setup', []],
].map(([name, aliases]) => ({
  name,
  description: 'Native command',
  argumentHint: '',
  builtin: true,
  ...(aliases.length ? { aliases } : {}),
}));

// the reload modes answer `reload_skills` with a bundled built-in and a user skill sharing a built-in's name
const reloading = ['reload-skills', 'reload-late', 'reload-linger'].includes(
  mode,
);

if (mode === 'reload-linger') process.on('SIGTERM', () => {});

const simplify = {
  name: 'simplify',
  description: 'Review the changed code',
  argumentHint: '',
  builtin: true,
};

const commands = [
  {
    name: 'compact',
    description: 'Compact the conversation',
    argumentHint: '',
    builtin: true,
    aliases: ['squash'],
  },
  {
    name: 'compact',
    description: 'Shadowed',
    argumentHint: '',
    aliases: ['shadowed'],
  },
  {
    name: 'effort',
    description: 'Set the effort level',
    argumentHint: '[low|high]',
    builtin: true,
  },
  ...stateCommands,
  { name: 'config', description: 'Shadowed', argumentHint: '' },
  { name: 'rename', description: 'Shadowed', argumentHint: '' },
  {
    name: 'review',
    description: 'Review changes',
    argumentHint: '<target>',
    aliases: ['rv'],
  },
  ...(reloading ? [simplify] : []),
];

let initialization = 0;
let model = 'claude-a';

const run = {
  lastPrompt: '',
  /** where a `reporting familiar` turn is: `before` the report, `reported` and not yet idle, `idle`, or `running` again. */
  reporting: '',
};

let lastInput = '';
/** the uuids of prompts sent during a steerable turn. */
const steered = [];
/** the uuids of prompts the CLI holds unread for an interrupt receipt. */
const held = [];

/** calls `then` once `file` exists in the cwd; the poll alone doesn't keep the CLI running. */
const once = (file, then) => {
  const poll = setInterval(() => {
    if (!existsSync(join(process.cwd(), file))) return;

    clearInterval(poll);
    then();
  }, 5);

  poll.unref();
};

const state = (state) => {
  if (
    !sessionState ||
    (state === 'idle' && existsSync(join(process.cwd(), 'hold-idle')))
  )
    return;

  send({
    type: 'system',
    subtype: 'session_state_changed',
    state,
    uuid: randomUUID(),
    session_id,
  });
};

const task = (subtype, fields) =>
  send({ type: 'system', subtype, ...fields, uuid: randomUUID(), session_id });

if (mode === 'compaction' || mode === 'background' || mode === 'mcp') {
  const read = (index) =>
    once(`events-${index}.json`, () => {
      for (const frame of JSON.parse(
        readFileSync(join(process.cwd(), `events-${index}.json`), 'utf8'),
      )) {
        if (mode === 'background' && frame.type === 'result') result(frame);
        else send({ uuid: randomUUID(), session_id, ...frame });

        if (
          frame.type === 'command_lifecycle' &&
          frame.state !== 'queued' &&
          (!frame.session_id || frame.session_id === session_id)
        ) {
          const index = held.indexOf(frame.command_uuid);

          if (index !== -1) held.splice(index, 1);
        }
      }

      task('commands_changed', {
        commands: [
          { name: `barrier-${index}`, description: '', argumentHint: '' },
        ],
      });

      read(index + 1);
    });

  read(1);
}

/** the live background tasks, as `background_tasks_changed` lists them. */
const level = (tasks) => task('background_tasks_changed', { tasks });

const streamEvent = (event, parent) =>
  send({
    type: 'stream_event',
    uuid: randomUUID(),
    session_id,
    parent_tool_use_id: parent,
    event,
  });

/**
 * streams a text reply as a delta before its full message, as partial messages do; `agent` marks a familiar's
 * frame, and frames that share `id` are blocks of one message.
 */
const assistant = (
  text,
  content = [{ type: 'text', text }],
  parent = null,
  agent = undefined,
  id = randomUUID(),
) => {
  if (text) {
    streamEvent({ type: 'message_start', message: { id } }, parent);

    streamEvent(
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text },
      },
      parent,
    );
  }

  send({
    type: 'assistant',
    uuid: randomUUID(),
    session_id,
    parent_tool_use_id: parent,
    ...(agent ? { agent_id: agent } : {}),
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model,
      content,
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
};

const toolResult = (id, content, parent = null, extra = {}) =>
  send({
    type: 'user',
    uuid: randomUUID(),
    session_id,
    parent_tool_use_id: parent,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content }],
    },
    ...extra,
  });

let results = 0;

const result = (fields = {}) => {
  results++;

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
    ...fields,
  });

  // a later native frame proves the adapter consumed the result before a test continues.
  if (
    mode === 'background' ||
    [
      'background familiar',
      'background workflow',
      'reporting familiar',
      'dropped tasks',
    ].includes(run.lastPrompt)
  )
    task('commands_changed', {
      commands: [
        { name: `result-${results}`, description: '', argumentHint: '' },
      ],
    });
};

/** exits beside a grandchild sharing stderr, which writes a line once this process is reaped and so after its `exit` event. */
const exitBeforeGrandchild = (code) => {
  spawn(
    '/bin/sh',
    [
      '-c',
      'while kill -0 "$0" 2>/dev/null; do :; done; echo grandchild line >&2',
      String(process.pid),
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );

  process.stderr.write('fixture stderr text\n', () => process.exit(code));
};

const finish = () => {
  // with lifecycle acknowledgements, a result names the input it answers
  result(mode === 'spell-user' ? { user_message_uuids: [lastInput] } : {});

  if (run.lastPrompt === 'wait for idle') {
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

    if (mode === 'exit-cleanly-when-idle')
      process.stdout.end(() => process.exit(0));
  }
};

const finishPeerAnswer = () => {
  assistant('Reading requests.');

  if (existsSync(join(process.cwd(), 'answer-refusal'))) {
    send({
      type: 'assistant',
      uuid: 'refused-frame',
      session_id,
      parent_tool_use_id: null,
      message: {
        id: 'refused-message',
        role: 'assistant',
        model,
        content: [
          { type: 'tool_use', id: 'refused-read', name: 'Read', input: {} },
        ],
      },
    });

    send({
      type: 'system',
      subtype: 'model_refusal_fallback',
      trigger: 'refusal',
      direction: 'retry',
      scope: 'session',
      original_model: model,
      fallback_model: model,
      request_id: null,
      retracted_message_uuids: ['refused-frame'],
      content: '',
      uuid: randomUUID(),
      session_id,
    });
  }

  const output = JSON.parse(peerAnswer(run.lastPrompt));

  assistant('', [
    {
      type: 'tool_use',
      id: 'answer-output',
      name: 'StructuredOutput',
      input: output,
    },
  ]);

  toolResult('answer-output', 'Valid output.');
  result({ structured_output: output });
  state('idle');
};

const context = {
  readFileSync,
  join,
  process,
  send,
  run,
  once,
  finish,
  assistant,
  toolResult,
  randomUUID,
  session_id,
  task,
  level,
  result,
  state,
  exitBeforeGrandchild,
  spawn,
  streamEvent,
  stateCommands,
};

for await (const line of lines) {
  const message = JSON.parse(line);

  if (
    mode === 'peer-answer' &&
    message.type === 'control_response' &&
    message.response.request_id === 'answer-approval'
  ) {
    writeFileSync(
      join(process.cwd(), 'answer-response.json'),
      JSON.stringify(message.response),
    );

    finishPeerAnswer();

    continue;
  }

  if (mode === 'background' || mode === 'catalog' || mode === 'mcp')
    appendFileSync(join(process.cwd(), 'wire.jsonl'), `${line}\n`);

  if (mode === 'pending-model' && message.type === 'user')
    message.message.content = message.message.content
      .split('User request:\n')
      .at(-1);

  if (message.type === 'control_request') {
    const request = message.request;
    let response = {};

    if (request.subtype === 'initialize') {
      initialization++;

      writeFileSync(
        join(process.cwd(), 'initialize.json'),
        JSON.stringify(request),
      );

      if (mode === 'hang-on-init') continue;

      if (mode === 'exit-on-init') {
        process.stderr.write('init exit text\n', () => process.exit(1));

        continue;
      }

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
        commands,
        agents: [],
        output_style: 'default',
        available_output_styles: [],
        account: {},
        models: [
          ...(mode === 'aliases'
            ? [
                ['default', 'claude-opus-5-5'],
                ['opus', 'claude-opus-5-5'],
                ['haiku', 'claude-haiku-5-5'],
              ].map(([value, resolvedModel]) => ({
                value,
                resolvedModel,
                displayName: value,
                description: 'fixture alias',
              }))
            : []),
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

    if (
      request.subtype === 'get_context_usage' &&
      existsSync(join(process.cwd(), 'hold-context'))
    ) {
      writeFileSync(
        join(process.cwd(), 'context-request.json'),
        JSON.stringify(message),
      );

      continue;
    }

    if (
      request.subtype === 'get_usage' &&
      existsSync(join(process.cwd(), 'hold-usage'))
    ) {
      writeFileSync(
        join(process.cwd(), 'usage-request.json'),
        JSON.stringify(message),
      );

      continue;
    }

    if (request.subtype === 'get_context_usage')
      response = { percentage: 12.5, maxTokens: 200000 };

    if (request.subtype === 'reload_skills' && mode === 'reload-refused') {
      send({
        type: 'control_response',
        response: {
          subtype: 'error',
          request_id: message.request_id,
          error: 'reload refused',
        },
      });

      continue;
    }

    if (request.subtype === 'reload_skills') {
      response = {
        skills: reloading
          ? [simplify, { name: 'compact', description: '', argumentHint: '' }]
          : [],
      };

      // like a skill sync, `reload-late` holds the input loop, marked by `reload-held`, until the test writes `release-reload` into the cwd
      if (mode === 'reload-late') {
        writeFileSync(join(process.cwd(), 'reload-held'), '');

        while (!existsSync(join(process.cwd(), 'release-reload')))
          await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }

    if (request.subtype === 'mcp_status') {
      if (mode === 'mcp' && existsSync(join(process.cwd(), 'hold-mcp')))
        continue;

      if (mode === 'mcp' && existsSync(join(process.cwd(), 'reject-mcp'))) {
        send({
          type: 'control_response',
          response: {
            subtype: 'error',
            request_id: message.request_id,
            error: 'MCP status unavailable',
          },
        });

        continue;
      }

      response = { mcpServers: mcpServers() };
    }

    if (request.subtype === 'get_task_output') {
      const outputs = JSON.parse(
        readFileSync(join(process.cwd(), 'task-outputs.json'), 'utf8'),
      );

      const output = outputs[request.task_id] ?? '';

      response = {
        output,
        total_bytes: Buffer.byteLength(output),
        truncated: false,
      };
    }

    if (
      request.subtype === 'stop_task' &&
      existsSync(join(process.cwd(), 'hold-stop'))
    )
      continue;

    if (request.subtype === 'stop_task')
      task('task_notification', {
        task_id: request.task_id,
        status: 'stopped',
        output_file: '',
        summary: 'Stopped',
      });

    if (request.subtype === 'get_usage')
      response = {
        session: {
          total_cost_usd: 0,
          total_api_duration_ms: 0,
          total_duration_ms: 0,
          total_lines_added: 4 * results,
          total_lines_removed: results,
          model_usage: {},
        },
        subscription_type: 'max',
        rate_limits_available: mode !== 'no-limits',
        rate_limits:
          mode === 'no-limits'
            ? null
            : {
                limits: [],
                five_hour: {
                  utilization: 23.5,
                  resets_at: '2033-05-18T03:33:20Z',
                },
                seven_day: { utilization: 61, resets_at: null },
                seven_day_opus: { utilization: 99, resets_at: null },
              },
        behaviors: null,
      };

    if (
      (request.subtype === 'set_model' &&
        existsSync(join(process.cwd(), 'reject-model'))) ||
      (request.subtype === 'apply_flag_settings' &&
        existsSync(join(process.cwd(), 'reject-effort')))
    ) {
      send({
        type: 'control_response',
        response: {
          subtype: 'error',
          request_id: message.request_id,
          error: `${request.subtype} refused`,
        },
      });

      continue;
    }

    if (request.subtype === 'set_model') {
      if (mode === 'pending-model') {
        writeFileSync(join(process.cwd(), 'model-entered'), '');

        continue;
      }

      model = request.model;
    }

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
      appendFileSync(join(process.cwd(), 'interrupts.log'), 'interrupt\n');

      if (existsSync(join(process.cwd(), 'hold-interrupt'))) {
        if (existsSync(join(process.cwd(), 'late-interrupt'))) {
          const waiting = setInterval(() => {}, 1000);

          process.once('SIGTERM', () => {
            clearInterval(waiting);

            send({
              type: 'control_response',
              response: {
                subtype: 'success',
                request_id: message.request_id,
                response: { still_queued: [] },
              },
            });

            result();
            state('idle');
            result();
            state('idle');
            writeFileSync(join(process.cwd(), 'late-response.json'), 'true');
            process.stdout.end(() => process.exit(0));
          });
        }

        continue;
      }

      if (mode === 'background') {
        response = {
          still_queued: existsSync(join(process.cwd(), 'receipt.json'))
            ? JSON.parse(
                readFileSync(join(process.cwd(), 'receipt.json'), 'utf8'),
              )
            : [...held],
        };

        if (!response.still_queued.length)
          setTimeout(() => {
            result({
              subtype: 'error_during_execution',
              is_error: true,
              errors: ['Turn interrupted.'],
            });

            state('idle');
          });
      } else if (
        (mode === 'hold-initial' || run.lastPrompt === 'reporting familiar') &&
        held.length
      )
        response = {
          still_queued: mode === 'first-reply-read' ? held.slice(1) : held,
        };
      else if (run.lastPrompt === 'still queued')
        response = { still_queued: ['q-1'] };
      // the first steered prompt was folded in at a tool step, so the CLI still holds the rest
      else if (run.lastPrompt === 'steerable' && steered.length > 1)
        response = { still_queued: steered.slice(1) };
      // after the reply Claude Code stops the familiar and idles, with no fresh result
      else if (run.lastPrompt === 'background familiar') {
        task('task_notification', {
          task_id: 'helper',
          status: 'stopped',
          output_file: '',
          summary: '',
        });

        setTimeout(() => state('idle'));
      } else {
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
    appendFileSync(join(process.cwd(), 'inputs.jsonl'), `${line}\n`);
    lastInput = message.uuid;

    if (mode === 'background') {
      if (run.lastPrompt) {
        held.push(message.uuid);

        continue;
      }
    }

    if (mode === 'compaction' && message.message.content === '/compact') {
      // whole, through a rename, since the test polls for it and parses what it reads
      writeFileSync(
        join(process.cwd(), 'compact.json.next'),
        JSON.stringify(message),
      );

      renameSync(
        join(process.cwd(), 'compact.json.next'),
        join(process.cwd(), 'compact.json'),
      );

      continue;
    }

    if (mode === 'hold-initial') {
      held.push(message.uuid);
      writeFileSync(join(process.cwd(), 'held.json'), JSON.stringify(message));

      continue;
    }

    if (run.lastPrompt === 'reporting familiar' && run.reporting === 'before') {
      held.push(message.uuid);

      appendFileSync(
        join(process.cwd(), 'steered.jsonl'),
        `${JSON.stringify(message.message.content)}\n`,
      );

      continue;
    }

    if (
      run.lastPrompt === 'reporting familiar' &&
      ['reported', 'running'].includes(run.reporting)
    )
      appendFileSync(
        join(process.cwd(), 'early.jsonl'),
        `${JSON.stringify(message.message.content)}\n`,
      );

    // the CLI answers a prompt sent while it waits on a background familiar or workflow, then idles once it reports
    if (
      ['background familiar', 'background workflow'].includes(run.lastPrompt)
    ) {
      appendFileSync(
        join(process.cwd(), 'steered.jsonl'),
        `${JSON.stringify(message.message.content)}\n`,
      );

      assistant('Answered.');
      result();

      task('task_notification', {
        task_id:
          run.lastPrompt === 'background workflow' ? 'workflow' : 'helper',
        status: 'completed',
        output_file: '',
        summary: '',
      });

      assistant('Reported.');
      result();
      once('allow-idle', () => state('idle'));

      continue;
    }

    // the CLI folds a prompt sent during a turn into it, here until one says to wrap up
    if (run.lastPrompt === 'steerable') {
      steered.push(message.uuid);

      appendFileSync(
        join(process.cwd(), 'steered.jsonl'),
        `${JSON.stringify(message.message.content)}\n`,
      );

      if (message.message.content === 'wrap up') {
        run.lastPrompt = '';
        finish();
      }

      continue;
    }

    run.lastPrompt = message.message.content;

    writeFileSync(
      join(process.cwd(), 'content.json'),
      JSON.stringify(run.lastPrompt),
    );

    if (
      mode === 'coordinator-reporting' &&
      typeof run.lastPrompt === 'string' &&
      run.lastPrompt.endsWith('User request:\nreporting familiar')
    )
      run.lastPrompt = 'reporting familiar';

    // Claude Code starts a pushed input before init advertises lifecycle acknowledgements
    if (mode === 'spell-user')
      for (const state of ['queued', 'started'])
        send({
          type: 'command_lifecycle',
          command_uuid: message.uuid,
          state,
          uuid: randomUUID(),
          session_id,
        });

    send({
      type: 'system',
      subtype: 'init',
      model,
      permissionMode: 'default',
      cwd: process.cwd(),
      session_id,
      tools: [],
      mcp_servers: mcpServers().map(({ name, status }) => ({ name, status })),
      slash_commands: [],
      apiKeySource: 'none',
      output_style: 'default',
      agents: [],
      skills: !['init-skills', 'reload-late', 'reload-refused'].includes(mode)
        ? []
        : ({
            'swap skills': ['advisor'],
            'repeat skills': ['advisor', 'advisor'],
          }[run.lastPrompt] ?? ['autocompact']),
      plugins: [],
      uuid: randomUUID(),
      claude_code_version: nativeVersion,
      ...(['background', 'spell-user'].includes(mode)
        ? { capabilities: ['msg_lifecycle_v1'] }
        : {}),
      ...(mode === 'init-effort' ? { effort: 'max' } : {}),
    });

    state('running');

    if (mode === 'peer-answer') {
      if (existsSync(join(process.cwd(), 'answer-approval'))) {
        send({
          type: 'control_request',
          request_id: 'answer-approval',
          request: {
            subtype: 'can_use_tool',
            tool_name: 'Read',
            input: {
              file_path:
                readFileSync(join(process.cwd(), 'answer-approval'), 'utf8') ||
                '/denied',
            },
            tool_use_id: 'denied-read',
          },
        });
      } else finishPeerAnswer();

      continue;
    }

    if (mode === 'background') {
      if (!sessionState) {
        assistant('Working.');

        continue;
      }

      assistant('Initial reply.');

      result({
        user_message_uuid: message.uuid,
        user_message_uuids: [message.uuid],
      });

      continue;
    }

    if (Object.hasOwn(turns, run.lastPrompt))
      turns[run.lastPrompt](context, message);
    else finish();
  } else if (
    message.type === 'control_response' &&
    ['permit-1', 'elicit-1', 'preview-request'].includes(
      message.response.request_id,
    )
  ) {
    const { response } = message.response;

    if (run.lastPrompt !== 'approval')
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

// `reload-linger` marks its closed input with `reload-closing`, then exits only once the test writes `release-reload`
if (mode === 'reload-linger') {
  writeFileSync(join(process.cwd(), 'reload-closing'), '');

  while (!existsSync(join(process.cwd(), 'release-reload')))
    await new Promise((resolve) => setTimeout(resolve, 10));
}
