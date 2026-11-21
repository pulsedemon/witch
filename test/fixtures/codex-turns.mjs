function exitWhenIdle(context) {
  const { finish, process } = context;
  finish('completed');
  process.stdout.write('', () => process.exit(1));
}

function addSkill(context) {
  const { run, notify, finish } = context;
  run.skillAdded = true;
  notify('skills/changed', {});
  finish('completed');
}

function usage(context) {
  const { notify, window, finish } = context;

  const tokens = (threadId, totalTokens) =>
    notify('thread/tokenUsage/updated', {
      threadId,
      turnId: 'turn-1',
      tokenUsage: {
        total: { totalTokens: 900000 },
        last: { totalTokens },
        modelContextWindow: 256000,
      },
    });

  tokens('native-thread', 64000);
  tokens('subagent-thread', 200000);

  const diff = (body, turnId = 'turn-1', threadId = 'native-thread') =>
    notify('turn/diff/updated', {
      threadId,
      turnId,
      diff: body
        ? `diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,3 @@\n${body}`
        : '',
    });

  const first = ' kept\n-old\n+one\n+++ added\n';

  const second =
    '+two\ndiff --git a/y b/y\n--- a/y\n+++ b/y\n@@ -1 +1 @@\n-a\n+b\n';

  diff('+one\n');
  // the turn's diff grows, and a content line can start like a header
  diff(first);
  // a later turn adds to the total, its second file's headers do not, and another thread's turn does not
  diff(second, 'turn-2');
  diff('+three\n+four\n-five\n', 'subagent-turn', 'subagent-thread');
  diff('+one\n');
  diff('', 'turn-2');
  diff('');
  diff(first);
  diff(second, 'turn-2');
  diff(second, 'turn-2');

  const limits = (limitId, primary) =>
    notify('account/rateLimits/updated', {
      rateLimits: { limitId, primary, secondary: null },
    });

  limits('codex', window(15, 300, 2000000100));
  limits('other', window(99, 300, 2000000100));
  finish('completed');
}

function familiarWork(context) {
  const { notify, process, join, finish } = context;

  const item = (method, threadId, fields) =>
    notify(method, {
      threadId,
      turnId: `${threadId}-turn`,
      item: fields,
    });

  notify('turn/started', {
    threadId: 'worker-thread',
    turn: { id: 'worker-thread-turn', status: 'inProgress' },
  });

  // its prompt and its thinking are no tool calls
  item('item/started', 'worker-thread', {
    type: 'userMessage',
    id: 'w-0',
    content: [],
  });

  const thinking = {
    type: 'reasoning',
    id: 'w-r',
    summary: [],
    content: [],
  };

  item('item/started', 'worker-thread', thinking);
  item('item/completed', 'worker-thread', thinking);

  const command = {
    type: 'commandExecution',
    id: 'w-1',
    command: 'pnpm test',
    cwd: process.cwd(),
  };

  item('item/started', 'worker-thread', command);

  item('item/completed', 'worker-thread', {
    ...command,
    status: 'completed',
  });

  item('item/started', 'worker-thread', {
    type: 'collabAgentToolCall',
    id: 'w-c',
    tool: 'spawnAgent',
    senderThreadId: 'worker-thread',
    receiverThreadIds: [],
    prompt: 'Check the docs',
    agentsStates: {},
    status: 'inProgress',
  });

  item('item/started', 'worker-thread', {
    type: 'imageView',
    id: 'w-2',
    path: join(process.cwd(), 'a.png'),
  });

  const message = { type: 'agentMessage', id: 'w-3', text: '' };
  item('item/started', 'worker-thread', message);
  item('item/completed', 'worker-thread', { ...message, text: 'Done.' });
  // a thread that never started a turn here is no familiar
  item('item/started', 'ghost-thread', { ...command, id: 'g-1' });

  notify('turn/completed', {
    threadId: 'worker-thread',
    turn: { id: 'worker-thread-turn', status: 'completed' },
  });

  // the finished thread is sent more input
  notify('turn/started', {
    threadId: 'worker-thread',
    turn: { id: 'worker-thread-turn-2', status: 'inProgress' },
  });

  // and starts again before that turn's last item and end arrive
  notify('turn/started', {
    threadId: 'worker-thread',
    turn: { id: 'worker-thread-turn-3', status: 'inProgress' },
  });

  notify('item/started', {
    threadId: 'worker-thread',
    turnId: 'worker-thread-turn-2',
    item: { ...command, id: 'w-4' },
  });

  notify('turn/completed', {
    threadId: 'worker-thread',
    turn: { id: 'worker-thread-turn-2', status: 'completed' },
  });

  finish('completed');
}

function familiars(context) {
  const { notify, send, process, run, finish } = context;

  const turn = (method, threadId, status) =>
    notify(method, { threadId, turn: { id: `${threadId}-turn`, status } });

  send({
    id: 95,
    method: 'item/commandExecution/requestApproval',
    params: {
      threadId: 'child-thread',
      turnId: 'child-thread-turn',
      itemId: 'child-tool',
      command: 'ls',
      cwd: process.cwd(),
    },
  });

  notify('serverRequest/resolved', {
    threadId: 'child-thread',
    requestId: 95,
  });

  turn('turn/started', 'child-thread', 'inProgress');

  notify('item/agentMessage/delta', {
    threadId: 'child-thread',
    turnId: 'child-thread-turn',
    itemId: 'child-message',
    delta: 'Child text.',
  });

  notify('model/rerouted', {
    threadId: 'child-thread',
    turnId: 'child-thread-turn',
    fromModel: run.model,
    toModel: 'model-child',
    reason: 'highRiskCyberActivity',
  });

  turn('turn/started', 'grandchild-thread', 'inProgress');
  turn('turn/completed', 'grandchild-thread', 'interrupted');
  turn('turn/started', 'failed-thread', 'inProgress');
  turn('turn/completed', 'failed-thread', 'failed');
  turn('turn/started', 'done-thread', 'inProgress');
  turn('turn/completed', 'done-thread', 'completed');
  turn('turn/completed', 'child-thread', 'completed');
  // the finished child is sent more input
  turn('turn/started', 'child-thread', 'inProgress');
  notify('turn/completed', { threadId: 'stray-thread', turn: null });

  notify('item/agentMessage/delta', {
    threadId: 'native-thread',
    itemId: 'message-1',
    delta: 'Parent text.',
  });

  finish('completed');
}

function familiarRestart(context) {
  const { notify, finish } = context;

  // the familiars, named by now, are sent more input
  for (const threadId of ['child-thread', 'grandchild-thread'])
    notify('turn/started', {
      threadId,
      turn: { id: `${threadId}-turn-2`, status: 'inProgress' },
    });

  finish('completed');
}

function malformed(context) {
  const { notify, finish } = context;

  for (let count = 0; count < 2; count++)
    notify('item/agentMessage/delta', { itemId: 7, delta: 'bad' });

  finish('completed');
}

function nullTurn(context) {
  const { notify } = context;
  notify('turn/completed', { threadId: 'native-thread', turn: null });
}

function inProgress(context) {
  const { finish } = context;
  finish('inProgress');
}

function failed(context) {
  const { finish } = context;
  finish('failed', { message: 'native failure' });
}

function usageLimit(context, request, prompt) {
  const { limitTurns, finish } = context;
  const [status, codexErrorInfo] = limitTurns[prompt];

  finish(status, {
    message: 'limit reached',
    codexErrorInfo,
    additionalDetails: null,
  });
}

function reroute(context) {
  const { notify, run, finish } = context;

  notify('model/rerouted', {
    threadId: 'native-thread',
    turnId: 'turn-1',
    fromModel: run.model,
    toModel: 'model-c',
    reason: 'highRiskCyberActivity',
  });

  finish('completed');
}

function turnText(context) {
  const { notify, finish } = context;

  for (const [itemId, delta] of [
    ['message-z', 'alpha draft'],
    ['message-a', 'bravo'],
    ['message-a', ' tail'],
  ])
    notify('item/agentMessage/delta', { itemId, delta });

  notify('item/completed', {
    item: { type: 'agentMessage', id: 'message-z', text: 'alpha final' },
  });

  notify('item/agentMessage/delta', {
    itemId: 'message-m',
    delta: 'discard',
  });

  notify('item/completed', {
    item: { type: 'agentMessage', id: 'message-m', text: '' },
  });

  finish('completed');
}

function error(context) {
  const { notify, finish } = context;

  const error = (message) => ({
    message,
    codexErrorInfo: null,
    additionalDetails: null,
  });

  for (const [willRetry, message] of [
    [true, 'retrying'],
    [false, 'native error'],
  ])
    notify('error', {
      threadId: 'native-thread',
      turnId: 'turn-1',
      willRetry,
      error: error(message),
    });

  finish('failed', error('native error'));
}

function tool(context) {
  const { notify, finish } = context;

  const item = {
    type: 'commandExecution',
    id: 'cmd-1',
    command: 'ls',
    cwd: '/elsewhere',
  };

  notify('item/started', {
    item: { type: 'userMessage', id: 'user-1', content: [] },
  });

  const reasoning = {
    type: 'reasoning',
    id: 'reasoning-1',
    summary: [],
    content: [],
  };

  notify('item/started', { item: reasoning });
  notify('item/completed', { item: reasoning });

  notify('item/started', {
    threadId: 'native-thread',
    turnId: 'turn-1',
    item: { ...item, status: 'inProgress', aggregatedOutput: null },
  });

  notify('item/commandExecution/outputDelta', {
    threadId: 'native-thread',
    turnId: 'turn-1',
    itemId: 'cmd-1',
    delta: 'a.md\n',
  });

  notify('item/completed', {
    threadId: 'native-thread',
    turnId: 'turn-1',
    item: { ...item, status: 'completed', aggregatedOutput: 'a.md\n' },
  });

  finish('completed');
}

function toolItems(context) {
  const { join, process, notify, finish } = context;

  for (const item of [
    {
      type: 'fileChange',
      id: 'patch-1',
      changes: [
        {
          path: join(process.cwd(), 'a.md'),
          kind: { type: 'update' },
          diff: '',
        },
        { path: 'b.md', kind: { type: 'add' }, diff: '' },
      ],
      status: 'completed',
    },
    {
      type: 'mcpToolCall',
      id: 'mcp-1',
      server: 'browser',
      tool: 'screenshot',
      arguments: { url: 'https://example.com' },
      extra: 'tool metadata',
      result: {
        content: [
          { type: 'text', text: 'Captured.' },
          {
            type: 'image',
            data: 'iVBORw==',
            mimeType: 'image/png',
            extra: 'image metadata',
          },
          // deliberately invalid image data must remain visible in the tool text
          { type: 'image', data: 42, mimeType: 'image/png' },
          { type: 'text', text: 'Other.', data: 'literal' },
          null,
          [false, 3, 'nested'],
        ],
      },
    },
    {
      type: 'mcpToolCall',
      id: 'mcp-2',
      server: 'files',
      tool: 'read',
      arguments: { path: join(process.cwd(), 'c.txt') },
    },
    {
      type: 'dynamicToolCall',
      id: 'dynamic-1',
      tool: 'read',
      arguments: { path: join(process.cwd(), 'd.txt') },
      status: 'completed',
    },
    { type: 'imageView', id: 'view-1', path: '/shots/a.png' },
    {
      type: 'collabAgentToolCall',
      id: 'collab-1',
      tool: 'spawnAgent',
      senderThreadId: 'thread-1',
      receiverThreadIds: ['worker-thread'],
      prompt: 'Review the diff\nthen report',
      agentsStates: {},
      status: 'completed',
    },
    {
      type: 'collabAgentToolCall',
      id: 'collab-2',
      tool: 'closeAgent',
      senderThreadId: 'thread-1',
      receiverThreadIds: ['worker-thread'],
      prompt: null,
      agentsStates: {},
      status: 'completed',
    },
    {
      type: 'subAgentActivity',
      id: 'activity-1',
      agentThreadId: 'worker-thread',
      agentPath: '/root/worker',
      kind: 'started',
    },
  ])
    notify('item/completed', { item });

  finish('completed');
}

function fileChanges(context) {
  const { join, process, notify, finish } = context;
  const at = (name) => join(process.cwd(), name);

  const patch = {
    type: 'fileChange',
    id: 'patch-1',
    changes: [
      {
        path: at('a.txt'),
        kind: { type: 'update', move_path: null },
        diff: '@@ -3,3 +3,3 @@\n gamma\n-delta\n+DELTA\n epsilon\n',
      },
      {
        path: at('b.txt'),
        kind: { type: 'add' },
        diff: 'new one\nnew two\n',
      },
      {
        path: at('c.txt'),
        kind: { type: 'delete' },
        diff: 'remove me\nsecond line\n',
      },
      {
        path: at('d.txt'),
        kind: { type: 'update', move_path: at('e.txt') },
        diff: `@@ -1 +1 @@\n-x\n+y\n\n\nMoved to: ${at('e.txt')}`,
      },
    ],
  };

  notify('item/started', { item: { ...patch, status: 'inProgress' } });
  notify('item/completed', { item: { ...patch, status: 'completed' } });

  notify('item/completed', {
    item: {
      type: 'fileChange',
      id: 'patch-2',
      changes: [{ path: at('f.txt'), kind: { type: 'add' }, diff: 'f\n' }],
      status: 'declined',
    },
  });

  finish('completed');
}

function unknownRequest(context) {
  const { send } = context;
  send({ id: 92, method: 'item/unknown/request', params: {} });
}

function badRequest(context) {
  const { send } = context;

  send({
    id: 90,
    method: 'item/tool/requestUserInput',
    params: { questions: 'not a list' },
  });
}

function grandchild(context) {
  const { spawn, writeFileSync, file, process } = context;

  const grandchild = spawn('/bin/sleep', ['3'], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  writeFileSync(file('grandchild.pid'), String(grandchild.pid));
  process.exit(1);
}

function question(context) {
  const { send } = context;

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
}

async function withdrawn(context) {
  const { send, process, notify, held, finish } = context;

  send({
    id: 93,
    method: 'item/commandExecution/requestApproval',
    params: {
      threadId: 'native-thread',
      turnId: 'turn-1',
      itemId: 'tool-1',
      command: 'write withdrawn.txt',
      cwd: process.cwd(),
    },
  });

  notify('serverRequest/resolved', {
    threadId: 'native-thread',
    requestId: 93,
  });

  await held();
  finish('completed');
}

function permissions(context) {
  const { send } = context;

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
}

function fileChange(context) {
  const { send } = context;

  send({
    id: 94,
    method: 'item/fileChange/requestApproval',
    params: {
      threadId: 'native-thread',
      turnId: 'turn-1',
      itemId: 'patch-1',
      reason: 'write a.md',
    },
  });
}

function elicitation(context) {
  const { send } = context;

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
}

export const turns = {
  'exit when idle': exitWhenIdle,
  'add skill': addSkill,
  usage,
  'familiar-work': familiarWork,
  familiars,
  'familiar-restart': familiarRestart,
  malformed,
  'null-turn': nullTurn,
  'in-progress': inProgress,
  failed,
  'usage-limit': usageLimit,
  'rate-limit': usageLimit,
  'interrupted usage-limit': usageLimit,
  reroute,
  'turn text': turnText,
  error,
  tool,
  'tool-items': toolItems,
  'file-changes': fileChanges,
  'unknown-request': unknownRequest,
  'bad-request': badRequest,
  grandchild,
  question,
  withdrawn,
  permissions,
  'file change': fileChange,
  elicitation,
};
