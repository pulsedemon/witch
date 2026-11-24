import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from 'ink';
import { installedAgents } from './agents/registry.js';
import { errorMessage } from './errors.js';
import { controlPrefix } from './cli/cli-control.js';
import type { parseCommand } from './cli/cli-control.js';
import { Coordinator } from './core/coordinator.js';
import { SessionCoordination } from './core/coordination/coordination.js';
import { JobWatch, jobCheckpointSchema } from './core/jobs/jobs.js';
import { watchMerges } from './core/repository/merge-watch.js';
import { watchConflicts } from './core/repository/pr-repair.js';
import { RepositoryWatch } from './core/repository/repository.js';
import { WorkTreeChanges } from './core/repository/work-tree-changes.js';
import { watchCopilotReviews } from './core/review/copilot-review-watch.js';
import { keepAwake } from './core/jobs/wake.js';
import { Memory, memoryRepository } from './memory/memory.js';
import { instanceDirectory } from './persistence/instance.js';
import { writeJson } from './persistence/json.js';
import { DelegationStore } from './persistence/delegation.js';
import { router } from './core/runtime/router.js';
import { NotificationSchedule } from './persistence/notifications.js';
import { ScratchSpace } from './persistence/scratch.js';
import { StateStore } from './persistence/store.js';
import { App } from './ui/App.js';
import { Graphics } from './ui/transcript/images.js';
import { clickTarget } from './ui/links.js';
import { MouseInput, captureMouse, releaseMouse } from './ui/terminal/mouse.js';
import type { Cell, Pointer } from './ui/terminal/mouse.js';
import { Screen, recorded } from './ui/terminal/screen.js';
import { watchTerminal } from './ui/terminal/terminal.js';

// a built Witch rebuilds the checkout it runs from; Node resolves the bin symlink to the real path
const install = import.meta.url.endsWith('/dist/Witch.js')
  ? dirname(dirname(fileURLToPath(import.meta.url)))
  : undefined;

/** what a restart hands its replacement process through the environment. */
interface Handover {
  conversation?: string;
  scratch?: string;
  jobs?: string;
}

/**
 * keeps interactive startup out of headless commands and familiar wrappers.
 */
export async function runWitch(
  { values, positionals }: ReturnType<typeof parseCommand>,
  root: string,
  cli: string,
  {
    conversation: handedOver,
    scratch: handedScratch,
    jobs: handedJobs,
  }: Handover,
) {
  let store: StateStore;

  try {
    store = await StateStore.open(root);
  } catch (error) {
    process.stderr.write(`witch: ${errorMessage(error)}\n`);
    process.exit(1);
  }

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
  const memory = new Memory(memoryRepository(store.root));

  const coordination = await SessionCoordination.open(
    store,
    memory,
    join(scratch.directory, 'control'),
    (binding) => controlPrefix(binding, cli),
  );

  const notifications = await NotificationSchedule.open(
    join(store.root, 'notifications'),
  );

  const registrations = await installedAgents();

  // outside scratch, which agents can write: a symlink planted there would redirect Witch's own writes
  const changes = new WorkTreeChanges(
    instanceDirectory(join(store.root, 'changes')),
  );

  const coordinator = new Coordinator(
    store,
    memory,
    registrations,
    jobs,
    undefined,
    coordination,
    changes,
  );

  /** a desktop action that failed; nothing in the conversation depends on it. */
  const warn = (error: unknown) =>
    coordinator.notice(errorMessage(error), { save: false });

  const stopWake = keepAwake(coordinator, jobs, warn);
  const policy = await DelegationStore.open(join(store.root, 'delegation'));

  coordination.router = router(coordinator, policy, (deadline) =>
    coordination.routingDemand(deadline),
  );

  coordination.ownFamiliars = (action) => coordinator.reviewers.report(action);
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

  const stopCopilot = watchCopilotReviews(
    repository,
    coordinator,
    process.cwd(),
  );

  const stopMerges = watchMerges(repository, coordinator, install);
  const stopConflicts = watchConflicts(repository, coordinator);
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

  stdin.on('click', (presses: number) => {
    const link = pressed;

    // only the first click of a double or triple click opens a link
    if (!link || presses > 1) return;

    graphics
      .save(link)
      .then(() => clickTarget(link, () => coordinator.memoryDirectories()))
      .then((target) => {
        if ('notice' in target)
          coordinator.notice(target.notice, { save: false });
        else
          execFile('/usr/bin/open', [target.open], (error) => {
            if (error) warn(error);
          });
      })
      .catch(warn);
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
      copy={(text, copied) => {
        const child = execFile('/usr/bin/pbcopy', (error) => {
          if (error) warn(error);
          else copied();
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
  // a closed terminal fails every write and may send SIGHUP; whichever comes first stops a running Claude `!`
  // command before anything awaits
  const signals = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const;

  for (const signal of signals) process.on(signal, shutdown);

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
  stopConflicts();
  stopCopilot();
  stopCoordinationRepository();
  repository.close();
  changes.close();
  jobs.close();

  for (const signal of signals) process.removeListener(signal, shutdown);

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
    // the replacement takes over this pid's snapshot directory, so no snapshot operation here may still be running
    await changes.settled();
    // execve fires no exit event; the replacement resets job reports and resumes scratch
    restore();
    const id = coordinator.snapshot.conversation?.id ?? handedOver;
    // the replacement keeps this pid, so `-w` would never end the hold; any other exit ends it
    stopWake();

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
}
