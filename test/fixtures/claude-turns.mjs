function preview(context) {
  const { readFileSync, join, process, send, run, once, finish } = context;

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

  if (run.lastPrompt === 'preview-withdrawn')
    once('withdraw-preview', () => {
      send({
        type: 'control_cancel_request',
        request_id: 'preview-request',
      });

      finish();
    });
}

function approval(context) {
  const { send, join, process } = context;

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
}

function question(context) {
  const { send } = context;

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
            options: [{ label: 'red' }, { label: 'green' }, { label: 'blue' }],
          },
        ],
      },
      tool_use_id: 'tool-1',
    },
  });
}

function withdrawn(context) {
  const { send, join, process, finish } = context;

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
}

function elicit(context) {
  const { send } = context;

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
}

function tools(context) {
  const { assistant, toolResult, join, process, finish } = context;

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
      id: 'tool-s',
      name: 'Skill',
      input: { skill: 'handoff' },
    },
  ]);

  toolResult('tool-s', 'Launching skill: handoff');

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
}

function edits(context) {
  const { assistant, run, join, process, toolResult, finish } = context;

  const call = (id, name, input) =>
    assistant('', [{ type: 'tool_use', id, name, input }]);

  const a =
    run.lastPrompt === 'home-edits'
      ? '~/issue69-edit.txt'
      : join(process.cwd(), 'a.txt');

  call('edit-1', 'Edit', {
    file_path: a,
    old_string: 'bravo',
    new_string: 'BRAVO',
  });

  toolResult('edit-1', 'The file a.txt has been updated successfully.', null, {
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
  });

  const b = run.lastPrompt === 'home-edits' ? '~/issue69-write.txt' : 'b.txt';
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

  toolResult('write-2', 'The file c.txt has been updated successfully.', null, {
    tool_use_result: {
      type: 'update',
      filePath: c,
      content: 'same',
      structuredPatch: [],
      originalFile: 'same',
      userModified: false,
    },
  });

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
}

function createdEdits(context) {
  const { assistant, toolResult, finish } = context;
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
}

function familiarWork(context) {
  const { send, randomUUID, session_id, assistant, join, process, finish } =
    context;

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

  assistant(
    '',
    [tool('r-3', 'Skill', { skill: 'tdd' })],
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
}

function familiars(context) {
  const { task, finish } = context;

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
}

function brews(context) {
  const { task, level, finish } = context;

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
}

function reportingFamiliar(context) {
  const { task, assistant, result, run, once, state, exitBeforeGrandchild } =
    context;

  // reports and may start another familiar, then idles, then dies or runs again on its own and idles, each once the
  // test allows it
  task('task_started', {
    task_id: 'helper',
    description: 'Reporting helper',
    task_type: 'local_agent',
  });

  assistant('Started.');
  result();
  run.reporting = 'before';

  once('allow-report', () => {
    run.reporting = 'reported';

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
      run.reporting = 'idle';
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
        run.reporting = 'running';
        state('running');
        assistant('Brewed.');
        result();

        once('allow-rest', () => {
          run.reporting = 'idle';
          state('idle');
        });
      });
    });
  });
}

function backgroundFamiliar(context) {
  const { task, assistant, result } = context;

  task('task_started', {
    task_id: 'helper',
    description: 'Slow helper',
    task_type: 'local_agent',
  });

  assistant('Started.');
  // no idle until the familiar reports
  result();
}

function backgroundWorkflow(context) {
  const { task, assistant, result } = context;

  task('task_started', {
    task_id: 'workflow',
    description: 'Slow workflow',
    task_type: 'local_workflow',
  });

  assistant('Started.');
  // no idle until the workflow reports
  result();
}

function droppedTasks(context) {
  const { task, level, assistant, result, once, state } = context;

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
}

function wait(context) {
  const { assistant } = context;
  assistant('Working.');
}

function crash(context) {
  const { assistant, exitBeforeGrandchild } = context;
  assistant('Working.');
  exitBeforeGrandchild(1);
}

function die(context) {
  const { assistant, spawn, process } = context;
  assistant('Working.');
  // holds stdout, so the SDK's read loop outlives the exit
  spawn('/bin/sleep', ['1'], { stdio: ['ignore', 'inherit', 'ignore'] });
  process.exit(1);
}

function textError(context) {
  const { assistant, streamEvent, result, state } = context;
  assistant('alpha draft', undefined, null, undefined, 'message-z');
  assistant('bravo', undefined, null, undefined, 'message-a');

  streamEvent(
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: ' tail' },
    },
    null,
  );

  assistant('alpha final', undefined, null, undefined, 'message-z');
  assistant('', [], null, undefined, 'message-a');

  result({
    subtype: 'error_during_execution',
    is_error: true,
    result: undefined,
    errors: ['fixture failure'],
  });

  state('idle');
}

function executionError(context) {
  const { result, state } = context;

  result({
    subtype: 'error_during_execution',
    is_error: true,
    result: undefined,
    errors: ['tool crashed'],
  });

  state('idle');
}

function apiError(context) {
  const { result, state } = context;
  result({ is_error: true, result: 'API Error: 500' });
  state('idle');
}

function quitEarly(context) {
  const { process } = context;
  process.stderr.write('quitting early\n', () => process.exit(0));
}

function think(context) {
  const { streamEvent, assistant, finish } = context;

  const thought = {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'thinking_delta', thinking: 'secret plan' },
  };

  streamEvent(
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '', signature: '' },
    },
    null,
  );

  streamEvent(thought, null);
  streamEvent(thought, 'toolu_familiar');
  assistant('done');
  finish();
}

function addSkill(context) {
  const { send, stateCommands, randomUUID, session_id, finish } = context;

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
      ...stateCommands,
      { name: 'config', description: 'Shadowed', argumentHint: '' },
      { name: 'rename', description: 'Shadowed', argumentHint: '' },
      { name: 'later', description: 'Added later', argumentHint: '' },
    ],
    uuid: randomUUID(),
    session_id,
  });

  finish();
}

export const turns = {
  preview,
  'preview-withdrawn': preview,
  approval,
  question,
  withdrawn,
  elicit,
  tools,
  edits,
  'home-edits': edits,
  'created-edits': createdEdits,
  'familiar-work': familiarWork,
  familiars,
  brews,
  'reporting familiar': reportingFamiliar,
  'background familiar': backgroundFamiliar,
  'background workflow': backgroundWorkflow,
  'dropped tasks': droppedTasks,
  wait,
  'still queued': wait,
  steerable: wait,
  crash,
  die,
  'text error': textError,
  'execution error': executionError,
  'api error': apiError,
  'quit early': quitEarly,
  think,
  'add skill': addSkill,
};
