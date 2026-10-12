#!/usr/bin/env node
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { render } from 'ink';
import { installedAgents } from './agents/registry.js';
import { Coordinator } from './core/coordinator.js';
import { Memory } from './memory/memory.js';
import { StateStore } from './persistence/store.js';
import { App } from './ui/app.js';

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
} catch (error) {
  process.stderr.write(
    `witch: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
}
if (values.help) {
  process.stdout.write(usage);
} else {
  const stateDirectory = resolve(values['state-dir'] ?? defaultState);
  const prompt = positionals.join(' ');
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error('Witch needs an interactive terminal.');
  const store = await StateStore.open(stateDirectory);
  const coordinator = new Coordinator(
    store,
    new Memory(join(stateDirectory, 'memory.git')),
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
        process.stderr.write(`${String(error)}\n`);
        process.exitCode = 1;
      },
    );
  };
  const application = render(
    <App
      coordinator={coordinator}
      onExit={shutdown}
      initialPrompt={prompt || undefined}
    />,
    {
      alternateScreen: true,
      exitOnCtrlC: false,
      kittyKeyboard: {
        flags: ['disambiguateEscapeCodes', 'reportAssociatedText'],
      },
    },
  );
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  void coordinator
    .initialize(process.cwd(), { continue: values.continue })
    .catch((error: unknown) => coordinator.report(error));
  await application.waitUntilExit();
  process.removeListener('SIGTERM', shutdown);
  process.removeListener('SIGINT', shutdown);
}
