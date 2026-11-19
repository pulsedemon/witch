import assert from 'node:assert/strict';
import { test } from 'vitest';
import { controlPrefix, parseCommand } from '../../src/cli/cli-control.js';
import { boundCommandTitle, claudeTitle } from '../../src/agents/tool-title.js';
import { quote } from '../../src/shell.js';
import { cliOptions } from '../../src/cli-options.js';

const binding = {
  directory: '/task/control',
  conversation: 'conversation-one',
  activation: '11111111-1111-4111-8111-111111111111',
};

const prefixes = {
  control: controlPrefix(binding, '/witch/dist/cli.js'),
  familiar: controlPrefix(
    { ...binding, directory: '/task/control/familiars' },
    '/witch/dist/cli.js',
  ),
};

test('a boolean option ahead of a titled action does not take the action as its value', () => {
  for (const [name, option] of Object.entries(cliOptions)) {
    if (option.type !== 'boolean') continue;

    const command = `${prefixes.control} --${name} --claim task:x --summary s`;

    assert.deepEqual(
      boundCommandTitle(command, prefixes),
      name === 'peers' || name === 'preview-status'
        ? undefined
        : { title: 'claim task:x', expandedTitle: command, singleLine: true },
      name,
    );
  }
});

for (const [args, title] of [
  ['--peers --json', 'peers'],
  ['--preview-status --json', 'preview-status'],
  [
    "--preview 'frame with spaces.json' --json",
    'preview frame with spaces.json',
  ],
  ['--preview-close preview-id --json', 'preview-close preview-id'],
  [
    '--summary "mentions --release" --claim task:inspect-math-mjs-exports --alias task:exports --json',
    'claim task:inspect-math-mjs-exports',
  ],
  [
    '--recommend=https://github.com/pulsedemon/witch/issues/308 --selection ticket --summary inspect',
    'recommend https://github.com/pulsedemon/witch/issues/308',
  ],
  ['--release claim-id', 'release claim-id'],
  [
    '--release claim-id --reference task:side --reference https://github.com/acme/side/pull/12',
    'release references task:side, https://github.com/acme/side/pull/12',
  ],
  ['--reference=task:side --release claim-id', 'release references task:side'],
  ['--select-next turn-id --json', 'select-next turn-id'],
  ['--cancel-selection ticket-id', 'cancel-selection ticket-id'],
  ['--route review --of codex:gpt-6.1-sol --json', 'route review'],
]) {
  test(`a bound ${title!.split(' ')[0]} call retains its operand and complete command`, () => {
    const command = `${prefixes.control} ${args}`;

    assert.deepEqual(boundCommandTitle(command, prefixes), {
      title,
      expandedTitle: command,
      singleLine: true,
    });
  });
}

for (const extension of ['ts', 'tsx'])
  test(`native shell wrappers and .${extension} source-launch prefixes preserve quoted subjects`, () => {
    const source = {
      ...prefixes,
      control: controlPrefix(binding, `/witch/src/cli.${extension}`),
    };

    assert.ok(
      source.control.includes('TSX_TSCONFIG_PATH=/witch/tsconfig.json'),
    );

    assert.ok(source.control.includes('--import'));
    const command = `${source.control} --claim ${quote("task:reviewer's notes")} --summary inspect`;
    const doubleQuoted = `"${command.replace(/[\\"$`]/g, '\\$&')}"`;

    for (const wrapped of [
      command,
      `env TMPDIR='/task/tmp' ${command}`,
      `/bin/zsh -lc ${doubleQuoted}`,
      `/bin/bash -c ${quote(command)}`,
    ]) {
      assert.deepEqual(boundCommandTitle(wrapped, source), {
        title: "claim task:reviewer's notes",
        expandedTitle: wrapped,
        singleLine: true,
      });
    }
  });

test('familiar calls retain their name and stdin without reading action words from native arguments or heredocs', () => {
  const claude = `TMPDIR='/task/tmp' CLAUDE_CODE_TMPDIR='/task/tmp' ${prefixes.familiar} --familiar-claude ${quote("reviewer's pass")} --report-file '/task/report' -- --model opus <<'PROMPT'\nReview --claim example.\nPROMPT`;
  const codex = `${prefixes.familiar} --familiar-codex check --report-file '/task/report' -- -c model='gpt-6-astra' < '/task/prompt'`;

  for (const [command, title] of [
    [claude, "Familiar Claude reviewer's pass"],
    [`env ${claude}`, "Familiar Claude reviewer's pass"],
    [codex, 'Familiar Codex check'],
  ] as const) {
    assert.deepEqual(boundCommandTitle(command, prefixes), {
      title,
      expandedTitle: command,
      singleLine: true,
    });

    assert.equal(
      claudeTitle(
        'Bash',
        { command, description: 'Launch review' },
        '/task',
        prefixes,
      ).expandedTitle,
      `Bash  $ ${command}`,
    );
  }
});

test('mentions, other bindings and compound scripts keep their ordinary titles', () => {
  const call = `${prefixes.control} --peers --json`;

  for (const command of [
    call.replace('conversation-one', 'conversation-two'),
    call.replace(binding.activation, '22222222-2222-4222-8222-222222222222'),
    call.replace('/task/control', '/other/control'),
    call.replace('/witch/dist/cli.js', '/other/cli.js'),
    `printf '%s' ${quote(call)}`,
    'printf unquoted\u202fvalue',
    `${call} && git status`,
    `${call}\ngit status`,
    `${prefixes.familiar} --familiar-claude review --report-file /report -- <<'EOF'\ntext\nEOF\ngit status`,
  ]) {
    assert.equal(boundCommandTitle(command, prefixes), undefined, command);
  }

  assert.equal(boundCommandTitle(call, undefined), undefined);

  assert.deepEqual(
    claudeTitle('Bash', { command: 'git status' }, '/task', prefixes),
    {
      title: 'Bash  $ git status',
      command: true,
    },
  );

  assert.equal(
    claudeTitle('Bash', { command: call }, '/task', prefixes).command,
    true,
  );

  assert.equal(
    claudeTitle('Read', { file_path: '/task/a.ts' }, '/task').command,
    undefined,
  );

  assert.equal(
    claudeTitle('Other', { command: call }, '/task', prefixes).singleLine,
    undefined,
  );
});

test('later binding flags cannot disguise a foreign target as the bound call', () => {
  for (const [option, field, value] of [
    ['--control-dir', 'directory', '/another/control'],
    ['--control-conversation', 'conversation', 'conversation-two'],
    [
      '--control-activation',
      'activation',
      '22222222-2222-4222-8222-222222222222',
    ],
  ] as const) {
    const parsed = parseCommand([
      '--control-dir',
      binding.directory,
      '--control-conversation',
      binding.conversation,
      '--control-activation',
      binding.activation,
      option,
      value,
      '--peers',
      '--json',
    ]);

    assert.equal(parsed.control?.binding[field], value);

    for (const extra of [
      `${option} ${quote(value)}`,
      `${option}=${quote(value)}`,
    ]) {
      assert.equal(
        boundCommandTitle(
          `${prefixes.control} ${extra} --peers --json`,
          prefixes,
        ),
        undefined,
      );

      assert.equal(
        boundCommandTitle(
          `${prefixes.familiar} ${extra} --familiar-claude review --report-file /report -- --model opus`,
          prefixes,
        ),
        undefined,
      );
    }
  }
});
