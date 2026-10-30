#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
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
import { runClaudeFamiliar } from './cli-familiar.js';
import { runCodexFamiliar } from './cli-codex-familiar.js';
import { Coordinator } from './core/coordinator.js';
import { SessionCoordination } from './core/coordination.js';
import { JobWatch, jobCheckpointSchema } from './core/jobs.js';
import { watchMerges } from './core/merged.js';
import { RepositoryWatch } from './core/repository.js';
import { Memory } from './memory/memory.js';
import { instanceDirectory } from './persistence/instance.js';
import { writeJson } from './persistence/json.js';
import { DelegationStore } from './persistence/delegation.js';
import { router } from './core/router.js';
import { NotificationSchedule } from './persistence/notifications.js';
import { ScratchSpace } from './persistence/scratch.js';
import { StateStore } from './persistence/store.js';
import {
  assertNoPendingDirectoryRecovery,
  recoverDirectory,
} from './persistence/directory-recovery.js';
import { App } from './ui/app.js';
import { Graphics } from './ui/images.js';
import { clickTarget } from './ui/links.js';
import { MouseInput, captureMouse, releaseMouse } from './ui/mouse.js';
import type { Cell, Pointer } from './ui/mouse.js';
import { Screen, recorded } from './ui/screen.js';
import { watchTerminal } from './ui/terminal.js';

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
  --recover-directory <old>  preview recovery of a missing directory into this one
  --apply              apply the directory recovery with all Witches closed
  -h, --help           show this help

Agent control (use the prefix supplied in the current Witch context):
  --peers             list this project's sessions and reservations
  --claim <ref>       claim an issue/pr URL or task:<name>
  --summary <text>    describe the claimed work
  --alias <ref>       add a related reference to the claim
  --release <id>      release this conversation's exact claim
  --select-next <turn> wait for this turn's next-task selection slot
  --recommend <ref>   reserve a recommendation and advance the queue
  --selection <id>    identify the selection for --recommend
  --cancel-selection <id>  leave this turn's queue
  --route <work>      choose where review, planning, implementation or investigation goes
  --of <runtime>:<model>    the runtime and model whose work a review checks
  --named <runtime>:<model> a model the user or agent named, which runs as named, or a family, at its newest
  --json              print the control result as JSON

Delegated tasks (use the familiar prefix supplied in the current Witch context):
  --familiar-claude <name> --report-file <file> -- <native Claude arguments>
                      report a native Claude task as a familiar
  --familiar-codex <name> --report-file <file> -- <native app-server options>
                      report a Codex task as a familiar; read its prompt from stdin

Every word that starts with - is read as an option, so quote a prompt that
contains one, and put -- before a prompt that starts with -.
Use /help inside the app for controls.
`;

// the restart hands its conversation over here, and no agent or command may inherit it
const handedOver = process.env.WITCH_CONVERSATION;
const handedScratch = process.env.WITCH_SCRATCH;
const handedJobs = process.env.WITCH_JOBS_RESUME;
delete process.env.WITCH_CONVERSATION;
delete process.env.WITCH_SCRATCH;
delete process.env.WITCH_JOBS_RESUME;
let values;
let positionals;
let control;
let familiar;
let store: StateStore | undefined;
let directoryLock: FileHandle | undefined;
try {
  ({ values, positionals, control, familiar } = parseCommand());
  // parseArgs accepts an empty value, which would put state in the project
  if (values['state-dir'] === '')
    throw new Error("Option '--state-dir' needs a directory");
  if (
    !control &&
    !familiar &&
    !values.help &&
    values['recover-directory'] === undefined &&
    !(process.stdin.isTTY && process.stdout.isTTY)
  )
    throw new Error('Witch needs an interactive terminal.');
  if (!control && !familiar && !values.help) {
    const root = resolve(values['state-dir'] ?? defaultState);
    if (values['recover-directory'] !== undefined)
      await access(join(root, 'conversations'));
    store = await StateStore.open(root);
    if (values['recover-directory'] === undefined) {
      directoryLock = await store.lockDirectory('shared');
      await assertNoPendingDirectoryRecovery(store.root);
    }
  }
} catch (error) {
  if (process.argv.includes('--json'))
    writeControl({ kind: 'error', message: errorMessage(error) }, true);
  else process.stderr.write(`witch: ${errorMessage(error)}\n`);
  process.exit(1);
}
if (familiar) {
  try {
    const run =
      familiar.runtime === 'codex' ? runCodexFamiliar : runClaudeFamiliar;
    process.exitCode = await run(
      familiar.binding,
      familiar.name,
      familiar.reportFile,
      familiar.args,
    );
  } catch (error) {
    process.stderr.write(`witch: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
} else if (control) {
  process.exitCode = await runControl(control);
} else if (!store) {
  process.stdout.write(usage);
} else if (values['recover-directory'] !== undefined) {
  try {
    const report = await recoverDirectory(
      store,
      new Memory(join(store.root, 'memory.git')),
      values['recover-directory'],
      process.cwd(),
      !!values.apply,
    );
    process.stdout.write(
      [
        `Source: ${report.source}`,
        `Destination: ${report.destination}`,
        `Conversations: ${report.conversations}`,
        `Histories: ${report.histories}`,
        `Prompts: ${report.prompts}`,
        `Affected bytes: ${report.bytes}`,
        `Saved memory scopes: ${report.sourceProjects.join(', ') || 'not recorded'}`,
        `Records without a memory scope: ${report.unknownProjectRecords}`,
        `Destination memory scope: ${report.destinationProject}`,
        ...report.blockers.map((blocker) => `Blocked: ${blocker}`),
        ...(report.backup ? [`Backup: ${report.backup}`] : []),
        report.applied
          ? 'Recovery complete.'
          : 'Preview only. Close all Witches using this state directory, then repeat with --apply.',
      ].join('\n') + '\n',
    );
    if (values.apply && !report.applied) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`witch: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
} else {
  try {
    const prompt = positionals.join(' ');
    let stopTerminal: (() => void) | undefined;
    const restore = () => {
      process.stdout.write(releaseMouse);
      if (stopTerminal) {
        stopTerminal();
        stopTerminal = undefined;
        process.stdout.write('\u001b]2;\u001b\\');
      }
    };
    // runs on every exit, including a second Ctrl+C's process.exit and a crash, and first, so a slow directory removal
    // can't hold mouse reporting on
    process.once('exit', restore);
    const scratchParent = join(store.root, 'scratch');
    const scratchResume =
      handedScratch ??
      (handedOver &&
      process.env.TMPDIR === join(scratchParent, String(process.pid))
        ? process.env.TMPDIR
        : undefined);
    const scratch = await ScratchSpace.open(scratchParent, {
      resume: scratchResume,
    });
    const checkpointPath = join(scratch.directory, '.witch-jobs.json');
    if (handedJobs !== undefined && scratchResume === undefined)
      throw new Error('Restart jobs require resumed scratch.');
    const resume =
      handedJobs !== undefined
        ? jobCheckpointSchema.parse(
            JSON.parse(await readFile(checkpointPath, 'utf8')),
          )
        : undefined;
    // the pid keeps another live instance's mark from matching
    const jobs = new JobWatch({
      directory: instanceDirectory(join(store.root, 'jobs')),
      resume,
    });
    process.env.TMPDIR = scratch.directory;
    const memory = new Memory(join(store.root, 'memory.git'));
    const coordination = await SessionCoordination.open(
      store,
      memory,
      join(scratch.directory, 'control'),
      (binding) => controlPrefix(binding, fileURLToPath(import.meta.url)),
    );
    const notifications = await NotificationSchedule.open(
      join(store.root, 'notifications'),
    );
    const coordinator = new Coordinator(
      store,
      memory,
      await installedAgents(),
      jobs,
      undefined,
      coordination,
    );
    const policy = await DelegationStore.open(join(store.root, 'delegation'));
    coordination.router = router(coordinator, policy);
    // straight to the terminal, since the link screen would read image data as printed text
    const graphics = new Graphics((data) => process.stdout.write(data));
    /** frees the images while the alternate screen that holds them is still active. */
    const unmount = () => {
      graphics.release();
      application.unmount();
    };
    let shuttingDown = false;
    const shutdown = () => {
      stopTerminal?.();
      // a second request quits without waiting for a stuck agent
      if (shuttingDown) {
        unmount();
        process.exit(130);
      }
      shuttingDown = true;
      void coordinator
        .close({ restart: restarting })
        .then(unmount, (error: unknown) => {
          unmount();
          process.stderr.write(`witch: ${errorMessage(error)}\n`);
          process.exitCode = 1;
        });
    };
    let restarting = false;
    const restart = () => {
      restarting = true;
      shutdown();
    };
    const repository = new RepositoryWatch(
      process.cwd(),
      undefined,
      async () => (await memory.scopePaths(process.cwd())).project,
    );
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
      const link = pressed;
      if (!link) return;
      graphics
        .save(link)
        .then(() => clickTarget(link, () => coordinator.memoryDirectories()))
        .then((target) => {
          if ('notice' in target)
            coordinator.notice(target.notice, undefined, false);
          else
            execFile('/usr/bin/open', [target.open], (error) => {
              if (error)
                coordinator.notice(errorMessage(error), undefined, false);
            });
        })
        .catch((error: unknown) =>
          coordinator.notice(errorMessage(error), undefined, false),
        );
    });
    const application = render(
      <App
        coordinator={coordinator}
        repository={repository}
        jobs={jobs}
        store={store}
        policy={policy}
        onExit={shutdown}
        onRestart={restart}
        initialPrompt={prompt || undefined}
        graphics={graphics}
        copy={(text) => {
          const child = execFile('/usr/bin/pbcopy', (error) => {
            if (error)
              coordinator.notice(errorMessage(error), undefined, false);
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
    stopTerminal = watchTerminal(
      coordinator,
      coordination,
      (data) => process.stdout.write(data),
      notifications,
    );
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
      if (restarting) await writeJson(checkpointPath, await jobs.checkpoint());
    } catch (error) {
      throw new Error(
        `Preserving jobs for restart failed: ${errorMessage(error)}`,
        { cause: error },
      );
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
          WITCH_JOBS_RESUME: '1',
          ...(id ? { WITCH_CONVERSATION: id } : {}),
        },
      );
    }
  } finally {
    await directoryLock?.close();
  }
}
