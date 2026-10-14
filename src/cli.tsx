#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { render } from 'ink';
import { installedAgents } from './agents/registry.js';
import { errorMessage } from './agents/stderr.js';
import { Coordinator } from './core/coordinator.js';
import { RepositoryWatch } from './core/repository.js';
import { Memory } from './memory/memory.js';
import { StateStore } from './persistence/store.js';
import { App } from './ui/app.js';
import { MouseInput, captureMouse, releaseMouse } from './ui/mouse.js';
import type { Click } from './ui/mouse.js';
import { Screen, recorded } from './ui/screen.js';

const defaultState = join(homedir(), '.witch');
const usage = `Usage: witch [options] [prompt...]

Start a conversation in the current directory on the agent, model and effort
you last used, sending the prompt if one is given.

Options:
  -c, --continue       continue this directory's most recent conversation
  --state-dir <dir>    keep conversations and memory in <dir> (default ${defaultState})
  -h, --help           show this help

Every word that starts with - is read as an option, so quote a prompt that
contains one, and put -- before a prompt that starts with -.
Use /help inside the app for controls.
`;

let values;
let positionals;
let store: StateStore | undefined;
try {
  ({ values, positionals } = parseArgs({
    options: {
      'state-dir': { type: 'string' },
      continue: { type: 'boolean', short: 'c' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
    strict: true,
  }));
  // parseArgs accepts an empty value, which would put state in the project
  if (values['state-dir'] === '')
    throw new Error("Option '--state-dir' needs a directory");
  if (!values.help && !(process.stdin.isTTY && process.stdout.isTTY))
    throw new Error('Witch needs an interactive terminal.');
  if (!values.help)
    store = await StateStore.open(resolve(values['state-dir'] ?? defaultState));
} catch (error) {
  process.stderr.write(`witch: ${errorMessage(error)}\n`);
  process.exit(1);
}
if (!store) {
  process.stdout.write(usage);
} else {
  const prompt = positionals.join(' ');
  const coordinator = new Coordinator(
    store,
    new Memory(join(store.root, 'memory.git')),
    await installedAgents(),
  );
  let shuttingDown = false;
  const shutdown = () => {
    // a second request quits without waiting for a stuck agent
    if (shuttingDown) {
      application.unmount();
      process.exit(130);
    }
    shuttingDown = true;
    void coordinator.close().then(
      () => application.unmount(),
      (error: unknown) => {
        application.unmount();
        process.stderr.write(`witch: ${errorMessage(error)}\n`);
        process.exitCode = 1;
      },
    );
  };
  const repository = new RepositoryWatch(process.cwd());
  const screen = new Screen(process.stdout);
  const stdin = new MouseInput(process.stdin);
  stdin.on('click', ({ column, row }: Click) => {
    const link = screen.linkAt(column, row);
    if (link)
      execFile('/usr/bin/open', [link], (error) => {
        if (error) coordinator.report(error);
      });
  });
  const application = render(
    <App
      coordinator={coordinator}
      repository={repository}
      onExit={shutdown}
      initialPrompt={prompt || undefined}
    />,
    {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: recorded(process.stdout, screen),
      alternateScreen: true,
      exitOnCtrlC: false,
      kittyKeyboard: {
        flags: ['disambiguateEscapeCodes', 'reportAssociatedText'],
      },
    },
  );
  process.stdout.write(captureMouse);
  // runs on every exit, including a second Ctrl+C's process.exit and a crash
  process.once('exit', () => process.stdout.write(releaseMouse));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  void coordinator
    .initialize(process.cwd(), { continue: values.continue })
    // initialize shows its own failure
    .catch(() => {});
  await application.waitUntilExit();
  repository.close();
  process.removeListener('SIGTERM', shutdown);
  process.removeListener('SIGINT', shutdown);
}
