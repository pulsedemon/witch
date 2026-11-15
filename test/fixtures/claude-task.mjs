#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { clearInterval, setInterval } from 'node:timers';
import { spawn } from 'node:child_process';

const mode = process.env.WITCH_FAMILIAR_FIXTURE;
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const session_id = 'native-review';

const launch = {
  pid: process.pid,
  argv: process.argv.slice(2),
  prompt: readFileSync(0, 'utf8'),
  mark: process.env.WITCH_FAMILIAR_MARK,
  tmp: process.env.TMPDIR,
};

writeFileSync('launched.json', JSON.stringify(launch));

if (mode === 'ignore-term') process.on('SIGTERM', () => {});

const init = `${JSON.stringify({ type: 'system', subtype: 'init', session_id, model: 'claude-observed' })}\r\n`;
process.stdout.write(init.slice(0, 37));
process.stdout.write(init.slice(37));

for (const id of ['read-a', 'read-a', 'read-b'])
  emit({
    type: 'assistant',
    session_id,
    parent_tool_use_id: null,
    message: {
      model: 'claude-response',
      content: [
        {
          type: 'tool_use',
          id,
          name: 'Read',
          input: { file_path: join(process.cwd(), 'plan.md') },
        },
      ],
    },
  });

process.stderr.write('native stderr\n');

emit({
  type: 'result',
  subtype: 'success',
  session_id,
  is_error: false,
  result: 'Full review.\n'.repeat(7000),
  permission_denials: [],
});

writeFileSync('result-sent', 'yes');

if (mode === 'nonzero') process.exitCode = 2;
else if (mode === 'held-pipe') {
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},5000)'], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  writeFileSync('descendant.pid', String(child.pid));
  child.unref();
} else if (['gated', 'ignore-term', 'later-turn'].includes(mode)) {
  // exits once stdout drains: on macOS pipe writes are async, so process.exit would drop an unread result
  const timer = setInterval(() => {
    if (!existsSync('exit')) return;

    clearInterval(timer);

    // as Claude Code does when a background task ends after the answer
    if (mode === 'later-turn')
      emit({
        type: 'result',
        subtype: 'success',
        session_id,
        is_error: false,
        result: 'Stopped the background search.',
        permission_denials: [],
      });
  }, 10);
}
