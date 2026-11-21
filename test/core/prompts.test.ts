import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { Skill } from '../../src/agents/types.js';
import { skillCall } from '../../src/core/prompts.js';

const skills: Skill[] = [
  {
    name: 'usage',
    description: 'Native usage',
    builtin: true,
    aliases: ['cost', 'stats'],
  },
  {
    name: 'config',
    description: 'Native settings',
    builtin: true,
    aliases: ['settings'],
    sendAsText: true,
  },
  { name: 'audit', description: 'Project audit' },
];

test('built-in aliases keep their typed name and arguments in a native call', () => {
  for (const [prompt, name, args] of [
    ['/cost report', 'cost', 'report'],
    ['  /stats\nreport  ', 'stats', 'report'],
    ['/usage', 'usage', ''],
  ] as const)
    assert.deepEqual(skillCall(prompt, skills), {
      name,
      args,
      builtin: true,
    });
});

test('an exact spell name wins over a built-in alias listed before it', () => {
  for (const name of ['cost', 'settings'])
    assert.deepEqual(
      skillCall(`/${name} report`, [
        ...skills,
        { name, description: 'Project spell' },
      ]),
      { name, args: 'report' },
    );
});

test('text commands and their aliases have no native call', () => {
  for (const prompt of ['/config x', '/settings x'])
    assert.equal(skillCall(prompt, skills), undefined);
});

test('ordinary spells still match exactly and unknown slash prompts stay text', () => {
  assert.deepEqual(skillCall('/audit now', skills), {
    name: 'audit',
    args: 'now',
  });

  for (const prompt of ['/unknown', '/COST', 'cost', '/'])
    assert.equal(skillCall(prompt, skills), undefined);
});
