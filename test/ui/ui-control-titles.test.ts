import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createElement } from 'react';
import { agentDisplay, applyDisplayUpdate } from '../../src/core/state.js';
import { boundCommandTitle } from '../../src/agents/tool-title.js';
import { claudeTitle } from '../../src/agents/claude/tool-title.js';
import { App } from '../../src/ui/App.js';
import { show, fake, drag, TAB, ENTER } from '../fixtures/ui.js';
import { until } from '../fixtures/within.js';

const CMD_C = '\u001b[99;9u';

for (const runtime of ['Codex', 'Claude']) {
  test(`${runtime} control calls use one row at 120 columns and copy the full command only when expanded`, async () => {
    const prefixes = {
      control:
        "'/node' '/witch' '--control-dir' '/task/control' '--control-conversation' 'conversation' '--control-activation' 'activation'",
      familiar: 'unused',
    };

    const command = `${prefixes.control} --claim task:${'review-'.repeat(25)}subject-end --summary 'original summary'`;

    const title =
      runtime === 'Codex'
        ? boundCommandTitle(command, prefixes)
        : claudeTitle('Bash', { command }, '/work', prefixes);

    assert.ok(title);

    let items = applyDisplayUpdate(
      [],
      agentDisplay(
        {
          type: 'tool',
          id: 'control',
          ...title,
          text: 'input',
          done: false,
        },
        'control',
        runtime,
        '/work',
      ),
    );

    items = applyDisplayUpdate(
      items,
      agentDisplay(
        {
          type: 'tool',
          id: 'control',
          title: '',
          text: 'CONTROL-OUTPUT',
          done: true,
        },
        'control',
        runtime,
        '/work',
      ),
    );

    const { app } = fake({ items });
    const copied: string[] = [];

    const ui = show(
      createElement(App, {
        coordinator: app,
        onExit: () => {},
        copy: (text) => copied.push(text),
      }),
      120,
      30,
    );

    const rows = () => ui.text().split('\n');

    try {
      await until('the collapsed control', () =>
        ui.text().includes('+ ✓ claim task:'),
      );

      const at = rows().findIndex((row) => row.includes('+ ✓ claim task:'));
      const visible = rows()[at]!.slice(1, 84).trimEnd();
      assert.ok(visible.endsWith('…'));
      assert.ok(!ui.text().includes('subject-end'));
      assert.ok(!ui.text().includes('--control-dir'));
      drag(ui, [1, at], [83, at]);

      await until('the selected control', () =>
        ui.frame().includes('\u001b[7m'),
      );

      ui.stdin.write(CMD_C);
      await until('the compact copy', () => copied.length === 1);
      assert.equal(copied[0], visible);
      ui.stdin.write(`${TAB}${ENTER}`);

      await until('the expanded control', () =>
        ui.text().includes('CONTROL-OUTPUT'),
      );

      const first = rows().findIndex((row) => row.includes('− ✓'));

      const last =
        rows().findIndex((row) => row.includes('CONTROL-OUTPUT')) - 1;

      drag(ui, [1, first], [83, last]);

      await until('the selected command', () =>
        ui.frame().includes('\u001b[7m'),
      );

      ui.stdin.write(CMD_C);
      await until('the full copy', () => copied.length === 2);

      assert.equal(
        copied[1],
        `− ✓ ${runtime === 'Claude' ? 'Bash  $ ' : ''}${command}`,
      );

      ui.resize(100);

      await until('the resized expanded control', () =>
        ui.text().includes('original summary'),
      );

      ui.stdin.write(ENTER);

      await until(
        'the collapsed control again',
        () => !ui.text().includes('CONTROL-OUTPUT'),
      );

      assert.ok(!ui.text().includes('--control-dir'));
    } finally {
      ui.unmount();
    }
  });
}
