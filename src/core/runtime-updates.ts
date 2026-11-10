import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FileHandle } from 'node:fs/promises';
import { installedAgents } from '../agents/registry.js';
import type { AgentRegistration } from '../agents/registry.js';
import { nativeInstallationRoot } from '../agents/executable.js';
import {
  assessRuntimeUpdate,
  checkRuntimeUpdate,
  contentDigest,
  earlierArtifact,
  fileDigest,
  inspectRuntime,
  runtimeSchema,
} from '../agents/runtime-updates.js';
import type {
  NativeRuntime,
  RuntimeInstallation,
  RuntimeUpdateCheck,
} from '../agents/runtime-updates.js';
import { installNative } from '../agents/native-install.js';
import {
  prepareNativeUpdate,
  requiredNativeChecks,
  verificationProfile,
  verifyNativeUpdate,
} from '../agents/native-verification.js';
import { verificationAdapter } from '../agents/native-verification-profile.js';
import { errorMessage } from '../agents/stderr.js';
import {
  holdRuntime,
  pendingUpdate,
  qualifiedBy,
  RuntimeUpdateStore,
} from '../persistence/runtime-updates.js';
import type { UpdateJournal } from '../persistence/runtime-updates.js';
import { writeJson } from '../persistence/json.js';
import { runtimeUpdateUsers } from './runtime-update-users.js';

export interface RuntimeUpdateEntry {
  runtime: NativeRuntime;
  installation?: RuntimeInstallation;
  check?: RuntimeUpdateCheck;
  journal?: UpdateJournal;
  /** the newest older version on disk, which qualifying the installed one resumes from. */
  earlier?: string;
  /** why that lookup failed; it withholds the qualify offer and leaves the release check standing. */
  earlierError?: string;
  error?: string;
}
export interface RuntimeUpdateSnapshot {
  entries: readonly RuntimeUpdateEntry[];
  checking: boolean;
  build?: string;
  /** why this Witch build could not be identified; nothing can be verified against it. */
  buildError?: string;
  progress?: string;
  error?: string;
}
interface UpdateHost {
  cwd?(): string;
  maintain(
    runtime: NativeRuntime,
    run: (signal: AbortSignal) => Promise<void>,
  ): Promise<void>;
  notice(message: string): void;
}
const operations = {
  inspect: inspectRuntime,
  earlier: earlierArtifact,
  check: checkRuntimeUpdate,
  install: installNative,
  prepare: prepareNativeUpdate,
  verify: verifyNativeUpdate,
  users: runtimeUpdateUsers,
  startup: async (
    installation: RuntimeInstallation,
    directory: string,
    signal: AbortSignal,
  ) => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const adapter = await verificationAdapter(installation.runtime, directory);
    await adapter.models({
      executable: installation.executable,
      cwd: directory,
      signal,
    });
  },
};
export type NativeUpdateOperations = typeof operations;

export async function runtimeBuildIdentity(): Promise<string> {
  const tree = fileURLToPath(new URL('..', import.meta.url));
  const dependencies = import.meta.url.endsWith('.js')
    ? (
        JSON.parse(await readFile(join(tree, 'native-build.json'), 'utf8')) as {
          dependencies: string;
        }
      ).dependencies
    : await fileDigest(
        fileURLToPath(new URL('../../pnpm-lock.yaml', import.meta.url)),
      );
  const sdk = fileURLToPath(
    import.meta.resolve('@anthropic-ai/claude-agent-sdk'),
  );
  return createHash('sha256')
    .update(
      [
        await contentDigest(tree),
        dependencies,
        await fileDigest(
          fileURLToPath(
            new URL('../../node_modules/.pnpm/lock.yaml', import.meta.url),
          ),
        ),
        await fileDigest(sdk),
        process.version,
        process.platform,
        process.arch,
      ].join('\0'),
    )
    .digest('hex');
}

export class RuntimeUpdates {
  snapshot: RuntimeUpdateSnapshot = { entries: [], checking: false };
  private listeners = new Set<() => void>();
  private checking?: Promise<void>;
  private closed = false;
  private readonly stopping = new AbortController();
  private readonly build: Promise<string>;

  constructor(
    private readonly host: UpdateHost,
    private readonly store = new RuntimeUpdateStore(),
    private readonly native = operations,
    private readonly registrations: () => Promise<
      AgentRegistration[]
    > = installedAgents,
    private readonly identifyBuild = runtimeBuildIdentity,
  ) {
    this.build = identifyBuild();
    void this.build.then(
      (build) => {
        if (!this.closed) this.publish({ build });
      },
      (error: unknown) => {
        if (!this.closed) this.publish({ buildError: errorMessage(error) });
      },
    );
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private publish(update: Partial<RuntimeUpdateSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...update };
    for (const listener of this.listeners) listener();
  }

  private async record(journal: UpdateJournal): Promise<void> {
    await this.store.write(journal);
    const entries = [...this.snapshot.entries];
    const index = entries.findIndex(
      (entry) => entry.runtime === journal.previous.runtime,
    );
    const entry: RuntimeUpdateEntry = {
      ...(index < 0 ? { runtime: journal.previous.runtime } : entries[index]!),
      journal: { ...journal },
      ...(journal.selected ? { installation: journal.selected } : {}),
    };
    if (index < 0) entries.push(entry);
    else entries[index] = entry;
    this.publish({ entries });
  }

  private async maintain(
    runtime: NativeRuntime,
    run: (signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    this.publish({ error: undefined });
    try {
      await this.host.maintain(runtime, run);
    } catch (error) {
      this.publish({ error: errorMessage(error) });
      throw error;
    } finally {
      try {
        await this.check();
      } catch (error) {
        this.publish({
          error: [
            this.snapshot.error,
            `Status refresh failed: ${errorMessage(error)}`,
          ]
            .filter(Boolean)
            .join('\n'),
        });
      }
    }
  }

  async check(force = false): Promise<void> {
    if (this.checking) {
      await this.checking;
      if (!force) return;
    }
    if (this.closed) return;
    const checking = this.read(force);
    this.checking = checking;
    try {
      await checking;
    } finally {
      if (this.checking === checking) this.checking = undefined;
    }
  }

  private async read(force: boolean): Promise<void> {
    this.publish({ checking: true });
    try {
      const journals = await this.store.journals();
      const entries = await Promise.all(
        (await this.registrations()).map(async (registration) => {
          const runtime = runtimeSchema.parse(registration.adapter.id);
          const journal = journals
            .filter((value) => value.previous.runtime === runtime)
            .sort((a, b) => b.startedAt - a.startedAt)[0];
          if (journal && pendingUpdate(journal)) return { runtime, journal };
          let release: (() => void) | undefined;
          let installation: RuntimeInstallation | undefined;
          try {
            const root =
              registration.executable &&
              nativeInstallationRoot(registration.executable);
            if (root) release = holdRuntime(root, this.store.directory);
            installation = await this.native.inspect(
              registration,
              this.stopping.signal,
              this.host.cwd?.() ?? process.cwd(),
            );
            const cached = await this.store.cached(
              installation.root,
              installation.channel,
            );
            const check =
              !force &&
              cached?.installation.digest === installation.digest &&
              cached.installation.executable === installation.executable &&
              cached.installation.minimum === installation.minimum &&
              cached.installation.maximum === installation.maximum &&
              Date.now() - cached.checkedAt >= 0 &&
              Date.now() - cached.checkedAt < 24 * 60 * 60_000
                ? assessRuntimeUpdate(installation, cached)
                : await this.native.check(
                    installation,
                    AbortSignal.any([
                      this.stopping.signal,
                      AbortSignal.timeout(20_000),
                    ]),
                  );
            const notify = !this.closed && (await this.store.cache(check));
            if (notify && !this.closed) {
              this.host.notice(
                `${runtime === 'claude' ? 'Claude Code' : 'Codex'} ${check.target} is available. Open /updates to review it.`,
              );
            }
            return {
              runtime,
              installation,
              check,
              journal,
              ...(await this.native.earlier(installation).then(
                (artifact) => ({ earlier: artifact?.version }),
                (error: unknown) => ({ earlierError: errorMessage(error) }),
              )),
            };
          } catch (error) {
            return {
              runtime,
              installation,
              journal,
              error: errorMessage(error),
            };
          } finally {
            release?.();
          }
        }),
      );
      // entries are compared against the build, so they wait for it to settle
      await this.build.catch(() => undefined);
      if (!this.closed) this.publish({ entries });
    } finally {
      this.publish({ checking: false });
    }
  }

  private async registration(
    runtime: NativeRuntime,
  ): Promise<AgentRegistration> {
    const registration = (await this.registrations()).find(
      (value) => value.adapter.id === runtime,
    );
    if (!registration) throw new Error(`${runtime} is not installed.`);
    return registration;
  }

  private progress = (message: string) => this.publish({ progress: message });

  /** installs and qualifies `check.target`, or with no newer release qualifies the installed version. */
  async apply(
    check: RuntimeUpdateCheck,
    consent: { accountUsage: true },
  ): Promise<void> {
    if (!consent.accountUsage)
      throw new Error('Native qualification requires account-usage consent.');
    const installing = check.available;
    // every blocked reason restricts installing, and qualifying installs nothing
    if (installing && check.blocked) throw new Error(check.blocked);
    let qualified: UpdateJournal | undefined;
    let transaction: FileHandle | undefined;
    await this.maintain(check.installation.runtime, async (stop) => {
      const signal = AbortSignal.any([stop, AbortSignal.timeout(15 * 60_000)]);
      const installed = check.installation;
      const build = await this.build;
      if ((await this.identifyBuild()) !== build)
        throw new Error(
          'Witch changed since startup. Restart before updating or qualifying a native runtime.',
        );
      transaction = await this.store.transaction(installed.root);
      let exclusive: FileHandle | undefined;
      const journal: UpdateJournal = {
        id: randomUUID(),
        previous: installed,
        target: installing ? check.target : installed.version,
        build,
        phase: 'preparing',
        startedAt: Date.now(),
      };
      let recorded = false;
      let changed = false;
      let evidence: string | undefined;
      try {
        if (!installing)
          this.progress(`Qualifying ${installed.runtime} ${installed.version}`);
        const unfinished = await this.store.journal(installed.root);
        if (unfinished && pendingUpdate(unfinished))
          throw new Error('Recover the unfinished update first.');
        const registration = await this.registration(installed.runtime);
        const cwd = this.host.cwd?.() ?? process.cwd();
        const current = await this.native.inspect(registration, signal, cwd);
        if (
          current.root !== installed.root ||
          current.digest !== installed.digest ||
          current.launcher !== installed.launcher
        )
          throw new Error(
            'The installation changed. Check updates again before confirming.',
          );
        if (installing) {
          const fresh = await this.native.check(current, signal);
          await this.store.cache(fresh);
          if (
            fresh.target !== check.target ||
            fresh.blocked ||
            !fresh.available
          )
            throw new Error(
              fresh.blocked ??
                'The available release changed. Check updates again before confirming.',
            );
          await this.record(journal);
          recorded = true;
          exclusive = await this.store.exclusive(installed.root, signal);
          const users = await this.native.users(
            installed.root,
            this.store.directory,
          );
          if (users.length)
            throw new Error(
              users.map((user) => `PID ${user.pid}: ${user.reason}`).join('\n'),
            );
        } else {
          if (qualifiedBy(unfinished, current, build))
            throw new Error(
              'This version is already verified with this Witch build.',
            );
          const earlier = await this.native.earlier(current);
          if (!earlier)
            throw new Error(
              `No earlier ${installed.runtime} version is installed to check conversation resume against.`,
            );
          const artifact = await this.native.inspect(
            { ...registration, executable: earlier.executable },
            signal,
            cwd,
          );
          if (
            artifact.root !== current.root ||
            artifact.version !== earlier.version
          )
            throw new Error(
              `The earlier ${installed.runtime} artifact at ${earlier.executable} is not version ${earlier.version} of this installation.`,
            );
          // no journal is written until the checks pass: a pending one blocks launches and demands recovery
          journal.previous = {
            ...current,
            executable: artifact.executable,
            version: artifact.version,
            digest: artifact.digest,
          };
          journal.selected = current;
        }
        const directory = this.store.operation(journal);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        evidence = directory;
        const options = {
          directory,
          build: journal.build,
          allowAccountUsage: true,
          signal,
          progress: this.progress,
        };
        const prepared = await this.native.prepare(journal.previous, options);
        await writeJson(join(directory, 'prepared.json'), prepared);
        signal.throwIfAborted();
        let candidate = current;
        if (installing) {
          journal.phase = 'installing';
          await this.record(journal);
          changed = true;
          this.progress(`Installing ${installed.runtime} ${journal.target}`);
          await this.native.install(
            installed,
            journal.target,
            directory,
            signal,
          );
          candidate = await this.native.inspect(registration, signal, cwd);
          journal.selected = candidate;
          if (
            candidate.root !== installed.root ||
            candidate.version !== journal.target
          )
            throw new Error(
              'The native installer did not select the confirmed version.',
            );
          journal.phase = 'verifying';
          await this.record(journal);
        }
        const report = await this.native.verify(prepared, candidate, options);
        if (
          !report.passed ||
          report.build !== build ||
          report.profile !== verificationProfile ||
          report.runtime !== installed.runtime ||
          JSON.stringify(report.completed) !==
            JSON.stringify(requiredNativeChecks(installed.runtime)) ||
          report.previous.digest !== journal.previous.digest ||
          report.candidate.digest !== candidate.digest
        )
          throw new Error('Native qualification did not verify this version.');
        if ((await this.identifyBuild()) !== build)
          throw new Error('Witch changed during native qualification.');
        journal.phase = 'verified';
        await this.record(journal);
        qualified = journal;
      } catch (error) {
        if (recorded) {
          journal.error = errorMessage(error);
          if (changed) {
            try {
              await this.restore(journal);
            } catch (recovery) {
              journal.phase = 'failed';
              journal.error += `\nRecovery failed: ${errorMessage(recovery)}`;
              await this.record(journal);
            }
          } else {
            journal.phase = 'aborted';
            await this.record(journal);
          }
        }
        throw new Error(
          journal.error ??
            [
              errorMessage(error),
              ...(evidence ? [`Evidence: ${evidence}`] : []),
            ].join('\n'),
          { cause: error },
        );
      } finally {
        await exclusive?.close();
        this.publish({ progress: undefined });
      }
    })
      .catch(async (error: unknown) => {
        // a qualified installed version has nothing to recover to, so its record stands
        if (qualified && installing) {
          qualified.phase = 'failed';
          qualified.error = `Qualification passed, but reconnect failed: ${errorMessage(error)}`;
          await this.record(qualified);
        }
        throw error;
      })
      .finally(async () => {
        await transaction?.close();
        if (qualified?.phase === 'verified')
          this.host.notice(
            `${qualified.previous.runtime} ${qualified.selected!.version} ${installing ? 'installed and verified' : 'verified'}. Evidence: ${this.store.operation(qualified)}`,
          );
      });
  }

  private async restore(journal: UpdateJournal): Promise<void> {
    journal.phase = 'recovering';
    await this.record(journal);
    this.progress(
      `Recovering ${journal.previous.runtime} ${journal.previous.version}`,
    );
    const signal = AbortSignal.timeout(7 * 60_000);
    const registration = {
      ...(await this.registration(journal.previous.runtime)),
      executable: journal.previous.launcher,
    };
    const current = await this.native
      .inspect(registration, signal, this.host.cwd?.() ?? process.cwd())
      .catch(() => undefined);
    if (current && current.root !== journal.previous.root)
      throw new Error(
        'The launcher now selects another installation; recovery was refused.',
      );
    const directory = this.store.operation(journal);
    if (current?.digest !== journal.previous.digest) {
      journal.selected = undefined;
      await this.record(journal);
      await this.native.install(
        journal.previous,
        journal.previous.version,
        directory,
        signal,
      );
    }
    const restored = await this.native.inspect(
      registration,
      signal,
      this.host.cwd?.() ?? process.cwd(),
    );
    if (
      restored.version !== journal.previous.version ||
      restored.digest !== journal.previous.digest
    )
      throw new Error('Recovery did not restore the previous native artifact.');
    journal.selected = restored;
    await this.record(journal);
    await this.native.startup(restored, join(directory, 'recovery'), signal);
    journal.phase = 'recovered';
    await this.record(journal);
    this.host.notice(
      `Restored ${restored.runtime} ${restored.version}. The update did not complete. Evidence: ${directory}`,
    );
  }

  async recover(journal: UpdateJournal): Promise<void> {
    await this.maintain(journal.previous.runtime, async (signal) => {
      const transaction = await this.store.transaction(journal.previous.root);
      let exclusive: FileHandle | undefined;
      try {
        const current = await this.store.journal(journal.previous.root);
        if (!current || current.id !== journal.id || !pendingUpdate(current))
          throw new Error('Recovery state changed. Open /updates again.');
        exclusive = await this.store.exclusive(current.previous.root, signal);
        const users = await this.native.users(
          current.previous.root,
          this.store.directory,
        );
        if (users.length)
          throw new Error(
            users.map((user) => `PID ${user.pid}: ${user.reason}`).join('\n'),
          );
        try {
          await this.restore(current);
        } catch (error) {
          current.phase = 'failed';
          current.error = errorMessage(error);
          await this.record(current);
          throw error;
        }
      } finally {
        await exclusive?.close();
        await transaction.close();
        this.publish({ progress: undefined });
      }
    });
  }

  close(): void {
    this.closed = true;
    this.stopping.abort();
  }
}
