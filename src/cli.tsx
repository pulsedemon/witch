#!/usr/bin/env node
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { render } from 'ink';
import { installedAgents } from './agents/registry.js';
import { Coordinator } from './core/coordinator.js';
import { Memory } from './memory/memory.js';
import { StateStore } from './persistence/store.js';
import { App } from './ui/app.js';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  process.stdout.write(
    'Usage: harness [directory] [--state-dir directory]\n\nOpen a project in the terminal. Use /help inside the app for controls.\n',
  );
} else {
  const flag = args.indexOf('--state-dir');
  const stateDirectory =
    flag < 0
      ? join(homedir(), '.agent-harness')
      : resolve(args[flag + 1] ?? '');
  if (flag >= 0) args.splice(flag, 2);
  const directory = resolve(args[0] ?? process.cwd());
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error('The harness needs an interactive terminal.');
  const store = await StateStore.open(stateDirectory);
  const coordinator = new Coordinator(
    store,
    new Memory(join(stateDirectory, 'memory')),
    await installedAgents(),
  );
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
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
    <App coordinator={coordinator} onExit={shutdown} />,
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
    .initialize(directory)
    .catch((error: unknown) => coordinator.report(error));
  await application.waitUntilExit();
  process.removeListener('SIGTERM', shutdown);
  process.removeListener('SIGINT', shutdown);
}
