#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from 'ink';
import { installedAgents } from './agents/registry.js';
import { errorMessage } from './agents/stderr.js';
import {
  controlPrefix,
  parseCommand,
  runControl,
  writeControl,
} from './cli-control.js';
import { Coordinator } from './core/coordinator.js';
import { SessionCoordination } from './core/coordination.js';
import { JobWatch } from './core/jobs.js';
import { watchMerges } from './core/merged.js';
import { RepositoryWatch } from './core/repository.js';
import { Memory } from './memory/memory.js';
import { instanceDirectory } from './persistence/instance.js';
import { ScratchSpace } from './persistence/scratch.js';
import { StateStore } from './persistence/store.js';
import { App } from './ui/app.js';
import { Graphics } from './ui/images.js';
import { MouseInput, captureMouse, releaseMouse } from './ui/mouse.js';
import type { Cell, Pointer } from './ui/mouse.js';
import { Screen, recorded } from './ui/screen.js';

const defaultState = join(homedir(), '.witch');
// a built Witch rebuilds the checkout it runs from; Node resolves the bin symlink to the real path
const install = import.meta.url.endsWith('/dist/cli.js')
  ? dirname(dirname(fileURLToPath(import.meta.url)))
  : undefined;
const usage = `Usage: witch [options] [prompt...]

Start a conversation in the current directory on the agent, model and effort
you last used, sending the prompt if one is given.

Options:
  -c, --continue       continue this directory's most recent conversation
  --state-dir <dir>    keep conversations and memory in <dir> (default ${defaultState})
  -h, --help           show this help

Agent control (use the prefix supplied in the current Witch context):
  --peers             list this project's sessions and reservations
  --claim <ref>       claim an issue/pr URL or task:<name>
  --summary <text>    describe the claimed work
  --alias <ref>       add a related reference to the claim
  --release <id>      release this conversation's exact claim
  --json              print the control result as JSON

Every word that starts with - is read as an option, so quote a prompt that
contains one, and put -- before a prompt that starts with -.
Use /help inside the app for controls.
`;

// the restart hands its conversation over here, and no agent or command may inherit it
const handedOver = process.env.WITCH_CONVERSATION;
const handedScratch = process.env.WITCH_SCRATCH;
delete process.env.WITCH_CONVERSATION;
delete process.env.WITCH_SCRATCH;
let values;
let positionals;
let control;
let store: StateStore | undefined;
try {
  ({ values, positionals, control } = parseCommand());
  // parseArgs accepts an empty value, which would put state in the project
  if (values['state-dir'] === '')
    throw new Error("Option '--state-dir' needs a directory");
  if (
    !control &&
    !values.help &&
    !(process.stdin.isTTY && process.stdout.isTTY)
  )
    throw new Error('Witch needs an interactive terminal.');
  if (!control && !values.help)
    store = await StateStore.open(resolve(values['state-dir'] ?? defaultState));
} catch (error) {
  if (process.argv.includes('--json'))
    writeControl({ kind: 'error', message: errorMessage(error) }, true);
  else process.stderr.write(`witch: ${errorMessage(error)}\n`);
  process.exit(1);
}
if (control) {
  process.exitCode = await runControl(control);
} else if (!store) {
  process.stdout.write(usage);
} else {
  const prompt = positionals.join(' ');
  const restore = () => process.stdout.write(releaseMouse);
  // runs on every exit, including a second Ctrl+C's process.exit and a crash, and first, so a slow directory removal
  // can't hold mouse reporting on
  process.once('exit', restore);
  // the pid keeps another live instance's mark from matching
  const jobs = new JobWatch({
    directory: instanceDirectory(join(store.root, 'jobs')),
  });
  const scratchParent = join(store.root, 'scratch');
  const scratch = await ScratchSpace.open(scratchParent, {
    resume:
      handedScratch ??
      (handedOver &&
      process.env.TMPDIR === join(scratchParent, String(process.pid))
        ? process.env.TMPDIR
        : undefined),
  });
  process.env.TMPDIR = scratch.directory;
  const memory = new Memory(join(store.root, 'memory.git'));
  const coordination = await SessionCoordination.open(
    store,
    memory,
    join(scratch.directory, 'control'),
    (binding) => controlPrefix(binding, fileURLToPath(import.meta.url)),
  );
  const coordinator = new Coordinator(
    store,
    memory,
    await installedAgents(),
    jobs,
    undefined,
    coordination,
  );
  // straight to the terminal, since the link screen would read image data as printed text
  const graphics = new Graphics((data) => process.stdout.write(data));
  /** frees the images while the alternate screen that holds them is still active. */
  const unmount = () => {
    graphics.release();
    application.unmount();
  };
  let shuttingDown = false;
  let shutdownComplete = false;
  const shutdown = () => {
    // a second request quits without waiting for a stuck agent
    if (shuttingDown) {
      unmount();
      process.exit(130);
    }
    shuttingDown = true;
    void coordinator.close().then(
      () => {
        shutdownComplete = true;
        unmount();
      },
      (error: unknown) => {
        unmount();
        process.stderr.write(`witch: ${errorMessage(error)}\n`);
        process.exitCode = 1;
      },
    );
  };
  let restarting = false;
  const restart = () => {
    restarting = true;
    shutdown();
  };
  const repository = new RepositoryWatch(process.cwd());
  const stopCoordinationRepository = repository.subscribe(() =>
    coordination.updateRepository(repository.snapshot),
  );
  coordination.updateRepository(repository.snapshot);
  const stopMerges = watchMerges(repository, coordinator, install);
  const screen = new Screen(process.stdout);
  const stdin = new MouseInput(process.stdin);
  // output can scroll another link under the pointer before the release, so a click opens the one it pressed
  let pressed: string | undefined;
  const hover = ({ column, row }: Cell) => {
    const shape = screen.point(column, row);
    if (shape) process.stdout.write(shape);
  };
  stdin.on('hover', hover);
  stdin.on('pointer', (pointer: Pointer, cell: Cell) => {
    hover(cell);
    if (pointer === 'press') pressed = screen.linkAt(cell.column, cell.row);
  });
  stdin.on('click', () => {
    if (pressed)
      execFile('/usr/bin/open', [pressed], (error) => {
        if (error) coordinator.report(error);
      });
  });
  const application = render(
    <App
      coordinator={coordinator}
      repository={repository}
      jobs={jobs}
      store={store}
      onExit={shutdown}
      onRestart={restart}
      initialPrompt={prompt || undefined}
      graphics={graphics}
      copy={(text) => {
        const child = execFile('/usr/bin/pbcopy', (error) => {
          if (error) coordinator.report(error);
        });
        // a pbcopy that fails early fails the write with EPIPE, and the callback reports its failing exit
        child.stdin?.on('error', () => {}).end(text);
      }}
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
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  // a closed terminal fails every write and may send SIGHUP, and the first of these stops a running Claude `!`
  // command before anything awaits
  process.on('SIGHUP', shutdown);
  process.stdout.on('error', shutdown);
  void coordinator
    .initialize(process.cwd(), {
      continue: values.continue,
      conversation: handedOver,
    })
    // initialize shows its own failure
    .catch(() => {});
  await application.waitUntilExit();
  stopMerges();
  stopCoordinationRepository();
  repository.close();
  jobs.close();
  process.removeListener('SIGTERM', shutdown);
  process.removeListener('SIGINT', shutdown);
  process.removeListener('SIGHUP', shutdown);
  process.stdout.removeListener('error', shutdown);
  try {
    // a replacement watcher can miss inherited jobs, so resumed scratch stays until a later boot
    if (!restarting && !scratch.resumed && shutdownComplete) {
      const tracked = await jobs.tracked().catch((error: unknown) => {
        process.stderr.write(
          `witch: scratch retained: ${errorMessage(error)}\n`,
        );
        return undefined;
      });
      if (tracked?.length === 0) await scratch.remove();
    }
  } finally {
    await scratch.close();
  }
  if (restarting) {
    // execve fires no exit event; the replacement resets job reports and resumes scratch
    restore();
    const id = coordinator.snapshot.conversation?.id ?? handedOver;
    process.execve!(
      process.execPath,
      [
        process.execPath,
        ...process.execArgv,
        process.argv[1]!,
        '--state-dir',
        store.root,
      ],
      {
        ...process.env,
        WITCH_SCRATCH: scratch.directory,
        ...(id ? { WITCH_CONVERSATION: id } : {}),
      },
    );
  }
}
