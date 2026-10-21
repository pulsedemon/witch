import { setInterval, clearInterval, setTimeout } from 'node:timers';
import process from 'node:process';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import {
  appendFileSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from 'node:fs';
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
/** the uuids of prompts sent during a steerable turn. */
const steered = [];
/** where a `reporting familiar` turn is: `before` the report, `reported` and not yet idle, `idle`, or `running` again. */
let reporting = '';
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
const state = (state) =>
  send({
    type: 'system',
    subtype: 'session_state_changed',
    state,
    uuid: randomUUID(),
    session_id,
  });
const task = (subtype, fields) =>
  send({ type: 'system', subtype, ...fields, uuid: randomUUID(), session_id });
if (mode === 'compaction' || mode === 'background') {
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
    // the session's running total
    total_cost_usd: results * 0.25,
    ...fields,
  });
};
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
    // a background task's result, with no turn open
    if (lastPrompt === 'background result') setTimeout(() => result(), 20);
  }
};
for await (const line of lines) {
  const message = JSON.parse(line);
  if (mode === 'background')
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
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 23.5, resets_at: '2033-05-18T03:33:20Z' },
          seven_day: { utilization: 61, resets_at: null },
          seven_day_opus: { utilization: 99, resets_at: null },
        },
        behaviors: null,
      };
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
      if (mode === 'background') {
        response = {
          still_queued: existsSync(join(process.cwd(), 'receipt.json'))
            ? JSON.parse(
                readFileSync(join(process.cwd(), 'receipt.json'), 'utf8'),
              )
            : [...held],
        };
        if (!response.still_queued.length) setTimeout(() => state('idle'));
      } else if (
        (mode === 'hold-initial' || lastPrompt === 'reporting familiar') &&
        held.length
      )
        response = {
          still_queued: mode === 'first-reply-read' ? held.slice(1) : held,
        };
      else if (lastPrompt === 'still queued')
        response = { still_queued: ['q-1'] };
      // the first steered prompt was folded in at a tool step, so the CLI still holds the rest
      else if (lastPrompt === 'steerable' && steered.length > 1)
        response = { still_queued: steered.slice(1) };
      // after the reply Claude Code stops the familiar and idles, with no fresh result
      else if (lastPrompt === 'background familiar') {
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
    if (mode === 'background') {
      appendFileSync(join(process.cwd(), 'inputs.jsonl'), `${line}\n`);
      if (lastPrompt) {
        held.push(message.uuid);
        continue;
      }
    }
    if (mode === 'compaction' && message.message.content === '/compact') {
      writeFileSync(
        join(process.cwd(), 'compact.json'),
        JSON.stringify(message),
      );
      continue;
    }
    if (mode === 'hold-initial') {
      held.push(message.uuid);
      writeFileSync(join(process.cwd(), 'held.json'), JSON.stringify(message));
      continue;
    }
    if (lastPrompt === 'reporting familiar' && reporting === 'before') {
      held.push(message.uuid);
      appendFileSync(
        join(process.cwd(), 'steered.jsonl'),
        `${JSON.stringify(message.message.content)}\n`,
      );
      continue;
    }
    if (
      lastPrompt === 'reporting familiar' &&
      ['reported', 'running'].includes(reporting)
    )
      appendFileSync(
        join(process.cwd(), 'early.jsonl'),
        `${JSON.stringify(message.message.content)}\n`,
      );
    // the CLI answers a prompt sent while it waits on a background familiar or workflow, then idles once it reports
    if (['background familiar', 'background workflow'].includes(lastPrompt)) {
      appendFileSync(
        join(process.cwd(), 'steered.jsonl'),
        `${JSON.stringify(message.message.content)}\n`,
      );
      assistant('Answered.');
      result();
      task('task_notification', {
        task_id: lastPrompt === 'background workflow' ? 'workflow' : 'helper',
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
    if (lastPrompt === 'steerable') {
      steered.push(message.uuid);
      appendFileSync(
        join(process.cwd(), 'steered.jsonl'),
        `${JSON.stringify(message.message.content)}\n`,
      );
      if (message.message.content === 'wrap up') {
        lastPrompt = '';
        finish();
      }
      continue;
    }
    lastPrompt = message.message.content;
    writeFileSync(
      join(process.cwd(), 'content.json'),
      JSON.stringify(lastPrompt),
    );
    if (
      mode === 'coordinator-reporting' &&
      typeof lastPrompt === 'string' &&
      lastPrompt.endsWith('User request:\nreporting familiar')
    )
      lastPrompt = 'reporting familiar';
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
      ...(mode === 'background' ? { capabilities: ['msg_lifecycle_v1'] } : {}),
      ...(mode === 'init-effort' ? { effort: 'max' } : {}),
    });
    state('running');
    if (mode === 'background') {
      assistant('Initial reply.');
      result({
        user_message_uuid: message.uuid,
        user_message_uuids: [message.uuid],
      });
      continue;
    }
    if (lastPrompt === 'preview' || lastPrompt === 'preview-withdrawn') {
      const { tool, input } = JSON.parse(
        readFileSync(join(process.cwd(), 'preview.json'), 'utf8'),
      );
      send({
        type: 'control_request',
        request_id: 'preview-request',
        request: {
          subtype: 'can_use_tool',
          tool_name: tool,
          input,
          tool_use_id: 'preview-tool',
        },
      });
      if (lastPrompt === 'preview-withdrawn')
        once('withdraw-preview', () => {
          send({
            type: 'control_cancel_request',
            request_id: 'preview-request',
          });
          finish();
        });
      continue;
    }
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
    else if (lastPrompt === 'withdrawn') {
      send({
        type: 'control_request',
        request_id: 'permit-2',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'Write',
          input: { file_path: join(process.cwd(), 'withdrawn.txt') },
          tool_use_id: 'tool-2',
        },
      });
      send({ type: 'control_cancel_request', request_id: 'permit-2' });
      finish();
    } else if (lastPrompt === 'elicit')
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
    else if (lastPrompt === 'tools') {
      assistant('', [
        {
          type: 'tool_use',
          id: 'tool-1',
          name: 'Bash',
          input: { command: 'ls\nwc -l a.md', description: 'List notes' },
        },
      ]);
      toolResult('tool-1', 'a.md');
      assistant('', [
        {
          type: 'tool_use',
          id: 'tool-2',
          name: 'Agent',
          input: { description: 'Find notes', prompt: 'look' },
        },
      ]);
      assistant('Subagent text.', undefined, 'tool-2');
      assistant(
        '',
        [{ type: 'tool_use', id: 'sub-1', name: 'Read', input: {} }],
        'tool-2',
      );
      toolResult('sub-1', 'inner', 'tool-2');
      toolResult('tool-2', [
        { type: 'text', text: 'Found a.md.' },
        { type: 'text', text: 'Read one file.' },
      ]);
      assistant('', [
        {
          type: 'tool_use',
          id: 'tool-3',
          name: 'Read',
          input: { file_path: join(process.cwd(), 'shot.png') },
        },
      ]);
      toolResult('tool-3', [
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'iVBORw==' },
        },
      ]);
      assistant('Done.');
      finish();
    } else if (lastPrompt === 'edits' || lastPrompt === 'home-edits') {
      const call = (id, name, input) =>
        assistant('', [{ type: 'tool_use', id, name, input }]);
      const a =
        lastPrompt === 'home-edits'
          ? '~/issue69-edit.txt'
          : join(process.cwd(), 'a.txt');
      call('edit-1', 'Edit', {
        file_path: a,
        old_string: 'bravo',
        new_string: 'BRAVO',
      });
      toolResult(
        'edit-1',
        'The file a.txt has been updated successfully.',
        null,
        {
          tool_use_result: {
            filePath: a,
            oldString: 'bravo',
            newString: 'BRAVO',
            originalFile: 'alpha\nbravo\ncharlie\n',
            structuredPatch: [
              {
                oldStart: 1,
                oldLines: 3,
                newStart: 1,
                newLines: 3,
                lines: [' alpha', '-bravo', '+BRAVO', ' charlie'],
              },
            ],
            userModified: false,
            replaceAll: false,
          },
        },
      );
      const b = lastPrompt === 'home-edits' ? '~/issue69-write.txt' : 'b.txt';
      call('write-1', 'Write', { file_path: b, content: 'one\ntwo' });
      toolResult('write-1', `File created successfully at: ${b}`, null, {
        tool_use_result: {
          type: 'create',
          filePath: b,
          content: 'one\ntwo',
          structuredPatch: [],
          originalFile: null,
          userModified: false,
        },
      });
      const missing = 'Error: String to replace not found in file.';
      call('edit-2', 'Edit', {
        file_path: a,
        old_string: 'zulu',
        new_string: 'ZULU',
      });
      toolResult('edit-2', missing, null, { tool_use_result: missing });
      const c = join(process.cwd(), 'c.txt');
      call('write-2', 'Write', { file_path: c, content: 'same' });
      toolResult(
        'write-2',
        'The file c.txt has been updated successfully.',
        null,
        {
          tool_use_result: {
            type: 'update',
            filePath: c,
            content: 'same',
            structuredPatch: [],
            originalFile: 'same',
            userModified: false,
          },
        },
      );
      const settings = join(process.cwd(), '.claude', 'settings.json');
      call('write-3', 'Write', { file_path: settings, content: '{}' });
      toolResult('write-3', 'Staged for review.', null, {
        tool_use_result: {
          type: 'create',
          filePath: settings,
          content: '{}',
          structuredPatch: [],
          originalFile: null,
          userModified: false,
          staged: true,
        },
      });
      assistant('Done.');
      finish();
    } else if (lastPrompt === 'created-edits') {
      const content = Array.from({ length: 12 }, (_, index) => `l${index + 1}`);
      const reports = [
        {
          id: 'create-edit',
          filePath: 'created.txt',
          oldString: '',
          newString: content.join('\n') + '\n',
          originalFile: '',
          structuredPatch: [
            {
              oldStart: 0,
              oldLines: 0,
              newStart: 1,
              newLines: 12,
              lines: content.map((line) => `+${line}`),
            },
          ],
        },
        {
          id: 'append-edit',
          filePath: 'append.txt',
          oldString: 'base\n',
          newString: 'base\nnext\n',
          originalFile: 'base\n',
          structuredPatch: [
            {
              oldStart: 1,
              oldLines: 1,
              newStart: 1,
              newLines: 2,
              lines: [' base', '+next'],
            },
          ],
        },
        {
          id: 'staged-edit',
          filePath: '.claude/settings.json',
          oldString: '',
          newString: '{}\n',
          originalFile: '',
          structuredPatch: [
            {
              oldStart: 0,
              oldLines: 0,
              newStart: 1,
              newLines: 1,
              lines: ['+{}'],
            },
          ],
          staged: true,
        },
      ];
      for (const { id, ...report } of reports) {
        assistant('', [
          {
            type: 'tool_use',
            id,
            name: 'Edit',
            input: {
              file_path: report.filePath,
              old_string: report.oldString,
              new_string: report.newString,
            },
          },
        ]);
        toolResult(
          id,
          report.staged ? 'Staged for review.' : 'Updated successfully.',
          null,
          {
            tool_use_result: {
              ...report,
              userModified: false,
              replaceAll: false,
            },
          },
        );
      }
      assistant('Done.');
      finish();
    } else if (lastPrompt === 'familiar-work') {
      send({
        type: 'system',
        subtype: 'task_started',
        task_id: 'reader',
        description: 'Read tests',
        task_type: 'local_agent',
        uuid: randomUUID(),
        session_id,
      });
      const tool = (id, name, input) => ({ type: 'tool_use', id, name, input });
      assistant('Reading the tests.', undefined, 'agent-tool', 'reader');
      assistant(
        '',
        [tool('r-1', 'Read', { file_path: join(process.cwd(), 'a.test.ts') })],
        'agent-tool',
        'reader',
      );
      assistant(
        '',
        [
          tool('r-2', 'Bash', {
            command: 'pnpm test',
            description: 'Run tests',
          }),
        ],
        'agent-tool',
        'reader',
      );
      const report = randomUUID();
      assistant('All tests pass.', undefined, 'agent-tool', 'reader', report);
      assistant('See a.test.ts.', undefined, 'agent-tool', 'reader', report);
      // an agent Witch never listed, such as an ambient worker
      assistant(
        '',
        [tool('g-1', 'Read', { file_path: 'x' })],
        'other-tool',
        'ghost',
      );
      send({
        type: 'system',
        subtype: 'task_notification',
        task_id: 'reader',
        status: 'completed',
        output_file: '',
        summary: 'Agent "Read tests" finished',
        uuid: randomUUID(),
        session_id,
      });
      finish();
    } else if (lastPrompt === 'familiars') {
      task('task_started', {
        task_id: 'outer',
        description: 'Map the code',
        subagent_type: 'Explore',
        task_type: 'local_agent',
      });
      task('task_started', {
        task_id: 'inner',
        description: 'Read tests',
        parent_task_id: 'outer',
        task_type: 'local_agent',
      });
      task('task_started', {
        task_id: 'shell',
        description: 'ls',
        task_type: 'local_bash',
      });
      task('task_started', {
        task_id: 'worker',
        description: '/spell',
        subagent_type: 'general-purpose',
        task_type: 'local_agent',
        skip_transcript: true,
        ambient: true,
      });
      // run 1's start and notification arrive after run 2's start
      for (const run_id of ['1', '2', '1'])
        task('task_started', {
          task_id: 'resumed',
          run_id,
          description: 'Fix lint',
          task_type: 'local_agent',
        });
      for (const [run_id, status] of [
        ['1', 'stopped'],
        ['2', 'completed'],
      ])
        task('task_notification', {
          task_id: 'resumed',
          run_id,
          status,
          output_file: '',
          summary: '',
        });
      for (const [task_id, status] of [
        ['inner', 'completed'],
        ['shell', 'completed'],
        ['worker', 'completed'],
        ['outer', 'failed'],
      ])
        task('task_notification', {
          task_id,
          status,
          output_file: '',
          summary: '',
        });
      finish();
    } else if (lastPrompt === 'brews') {
      const outer = {
        task_id: 'outer',
        task_type: 'local_agent',
        description: 'Map the code',
      };
      const serve = {
        task_id: 'serve',
        task_type: 'local_bash',
        description: 'Start the server',
      };
      const moved = {
        task_id: 'moved',
        task_type: 'local_bash',
        description: 'Run tests',
      };
      const end = (task_id, status) =>
        task('task_notification', {
          task_id,
          status,
          output_file: '',
          summary: '',
        });
      level([outer]);
      task('task_started', outer);
      level([outer, serve]);
      task('task_started', { ...serve, is_backgrounded: true });
      // a foreground shell gets task frames but never joins the live set
      task('task_started', {
        task_id: 'build',
        task_type: 'local_bash',
        description: 'Build',
        is_backgrounded: false,
      });
      end('build', 'completed');
      // a foreground shell moved to the background joins the live set before its update
      task('task_started', { ...moved, is_backgrounded: false });
      level([outer, serve, moved]);
      task('task_updated', {
        task_id: 'moved',
        patch: { is_backgrounded: true },
      });
      task('task_updated', { task_id: 'serve', patch: { status: 'failed' } });
      end('serve', 'failed');
      level([outer, moved]);
      end('moved', 'stopped');
      level([outer]);
      end('outer', 'completed');
      level([]);
      finish();
    } else if (lastPrompt === 'reporting familiar') {
      // reports and may start another familiar, then idles, then dies or runs again on its own and idles, each once the
      // test allows it
      task('task_started', {
        task_id: 'helper',
        description: 'Reporting helper',
        task_type: 'local_agent',
      });
      assistant('Started.');
      result();
      reporting = 'before';
      once('allow-report', () => {
        reporting = 'reported';
        task('task_notification', {
          task_id: 'helper',
          status: 'completed',
          output_file: '',
          summary: '',
        });
        assistant('Reported.');
        result();
        once('allow-second', () =>
          task('task_started', {
            task_id: 'second',
            description: 'Second helper',
            task_type: 'local_agent',
          }),
        );
        once('allow-idle', () => {
          reporting = 'idle';
          state('idle');
          task('commands_changed', {
            commands: [
              {
                name: 'after-idle',
                description: 'After idle',
                argumentHint: '',
              },
            ],
          });
          once('allow-die', () => exitBeforeGrandchild(1));
          // as Claude Code does when a brew ends
          once('allow-run', () => {
            reporting = 'running';
            state('running');
            assistant('Brewed.');
            result();
            once('allow-rest', () => {
              reporting = 'idle';
              state('idle');
            });
          });
        });
      });
    } else if (lastPrompt === 'background familiar') {
      task('task_started', {
        task_id: 'helper',
        description: 'Slow helper',
        task_type: 'local_agent',
      });
      assistant('Started.');
      // no idle until the familiar reports
      result();
    } else if (lastPrompt === 'background workflow') {
      task('task_started', {
        task_id: 'workflow',
        description: 'Slow workflow',
        task_type: 'local_workflow',
      });
      assistant('Started.');
      // no idle until the workflow reports
      result();
    } else if (lastPrompt === 'dropped tasks') {
      // the live set drops the background tasks with no notification, once the test allows it
      const helper = {
        task_id: 'helper',
        task_type: 'local_agent',
        description: 'Slow helper',
      };
      const workflow = {
        task_id: 'workflow',
        task_type: 'local_workflow',
        description: 'Slow workflow',
      };
      const serve = {
        task_id: 'serve',
        task_type: 'local_bash',
        description: 'Start the server',
      };
      task('task_started', {
        task_id: 'fore',
        task_type: 'local_agent',
        description: 'Foreground helper',
        is_backgrounded: false,
      });
      level([helper]);
      task('task_started', { ...helper, is_backgrounded: true });
      level([helper, workflow]);
      task('task_started', workflow);
      level([helper, workflow, serve]);
      task('task_notification', {
        task_id: 'fore',
        status: 'completed',
        output_file: '',
        summary: '',
      });
      assistant('Started.');
      result();
      once('allow-drop', () => {
        level([]);
        once('allow-idle', () => state('idle'));
      });
    } else if (['wait', 'still queued', 'steerable'].includes(lastPrompt))
      assistant('Working.');
    else if (lastPrompt === 'crash') {
      assistant('Working.');
      exitBeforeGrandchild(1);
    } else if (lastPrompt === 'die') {
      assistant('Working.');
      // holds stdout, so the SDK's read loop outlives the exit
      spawn('/bin/sleep', ['1'], { stdio: ['ignore', 'inherit', 'ignore'] });
      process.exit(1);
    } else if (lastPrompt === 'execution error') {
      result({
        subtype: 'error_during_execution',
        is_error: true,
        result: undefined,
        errors: ['tool crashed'],
      });
      state('idle');
    } else if (lastPrompt === 'api error') {
      result({ is_error: true, result: 'API Error: 500' });
      state('idle');
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
          { name: 'clear', description: 'Shadowed', argumentHint: '' },
          { name: 'later', description: 'Added later', argumentHint: '' },
        ],
        uuid: randomUUID(),
        session_id,
      });
      finish();
    } else finish();
  } else if (
    message.type === 'control_response' &&
    ['permit-1', 'elicit-1', 'preview-request'].includes(
      message.response.request_id,
    )
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
