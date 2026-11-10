import { homedir } from 'node:os';
import { useSyncExternalStore } from 'react';
import type { RuntimeUpdates } from '../core/runtime-updates.js';
import type { Picker } from './choices.js';
import type {
  RuntimeUpdateEntry,
  RuntimeUpdateSnapshot,
} from '../core/runtime-updates.js';
import { pendingUpdate, qualifiedBy } from '../persistence/runtime-updates.js';
import { plain } from './links.js';

export const runtimeLabel = (runtime: string) =>
  runtime === 'claude' ? 'Claude Code' : 'Codex';

/** whether `/updates <runtime>` offers to qualify the installed version; a blocked check only restricts installing. */
function qualifiable(
  entry: RuntimeUpdateEntry,
  snapshot: RuntimeUpdateSnapshot,
): boolean {
  return (
    snapshot.build !== undefined &&
    !snapshot.progress &&
    !(entry.journal && pendingUpdate(entry.journal)) &&
    !!entry.check &&
    !entry.check.available &&
    entry.earlier !== undefined &&
    !qualifiedBy(entry.journal, entry.installation, snapshot.build)
  );
}

export function updateChoice(
  entry: RuntimeUpdateEntry,
  snapshot: RuntimeUpdateSnapshot,
): string {
  const name = runtimeLabel(entry.runtime);
  if (entry.journal && pendingUpdate(entry.journal))
    return `${name} · recovery required`;
  if (entry.error) return `${name} · check failed`;
  if (qualifiable(entry, snapshot))
    return `${name} · ${entry.installation!.version} · not verified`;
  if (entry.check?.blocked)
    return `${name} · ${entry.installation?.version ?? 'unavailable'} · setup needed`;
  return `${name} · ${entry.installation?.version ?? 'not installed'}${entry.check?.available ? ` → ${entry.check.target}` : ' · current'}`;
}

export function updatesText(snapshot: RuntimeUpdateSnapshot): string {
  const lines = [
    ...(snapshot.progress ? [snapshot.progress, ''] : []),
    ...(snapshot.checking ? ['Checking releases…', ''] : []),
    ...(snapshot.error ? [`Failed: ${snapshot.error}`, ''] : []),
    ...(snapshot.buildError
      ? [`Witch build identity failed: ${snapshot.buildError}`, '']
      : []),
    'Updates and qualification run only when you confirm, and their checks spend native account usage. A failed update keeps or restores the previous version, or leaves recovery pending here. Qualifying the installed version installs nothing; its failure is only reported.',
    '',
  ];
  for (const entry of snapshot.entries) {
    lines.push(runtimeLabel(entry.runtime));
    if (entry.journal && pendingUpdate(entry.journal)) {
      lines.push(
        `${snapshot.progress ? 'Update in progress' : 'Unfinished update'} to ${entry.journal.target}. Previous version: ${entry.journal.previous.version}.`,
        ...(entry.journal.selected
          ? [
              `Selected version: ${entry.journal.selected.version}; ${entry.journal.phase === 'verifying' ? 'verification' : 'recovery'} pending.`,
            ]
          : []),
        ...(snapshot.progress
          ? []
          : [`Run /updates ${entry.runtime} to recover.`]),
        entry.journal.error ?? '',
      );
    } else {
      if (entry.installation) {
        lines.push(`Installed: ${entry.installation.version}`);
        lines.push(`Installation: ${entry.installation.launcher}`);
        lines.push(
          `Native automatic updates: ${entry.installation.automatic ? 'enabled; may update independently of Witch' : 'disabled'}`,
        );
      }
      if (entry.check)
        lines.push(
          `Available on ${entry.check.installation.channel}: ${entry.check.target}`,
          `Source: ${entry.check.source}`,
          `Checked: ${new Date(entry.check.checkedAt).toLocaleString()}`,
          entry.check.blocked ?? '',
        );
      if (qualifiedBy(entry.journal, entry.installation, snapshot.build))
        lines.push('Verified with this Witch build.');
      else if (entry.installation)
        lines.push(
          'Not yet verified with this Witch build.',
          ...(qualifiable(entry, snapshot)
            ? [`Run /updates ${entry.runtime} to qualify it.`]
            : []),
          ...(entry.earlierError
            ? [`Earlier version lookup failed: ${entry.earlierError}`]
            : []),
        );
      if (entry.journal?.phase === 'recovered')
        lines.push(
          'The last update was recovered to the previous version.',
          entry.journal.error ?? '',
        );
      if (entry.error) lines.push(`Check failed: ${entry.error}`);
    }
    lines.push('');
  }
  lines.push(
    '/updates check refreshes releases. /updates claude or /updates codex opens confirmation.',
  );
  return plain(lines.join('\n'));
}

const unwatched = () => () => {};
const noUpdates: RuntimeUpdateSnapshot = { entries: [], checking: false };

export function useRuntimeUpdates(
  updates?: RuntimeUpdates,
): RuntimeUpdateSnapshot {
  return useSyncExternalStore(
    updates?.subscribe ?? unwatched,
    () => updates?.snapshot ?? noUpdates,
  );
}

export async function showUpdates(
  argument: string,
  updates: RuntimeUpdates | undefined,
  active: () => boolean,
  picker: Picker,
  details: () => boolean,
  notice: (text: string) => void,
): Promise<boolean> {
  if (!updates) {
    notice('Native updates are unavailable in this session.');
    return false;
  }
  if (argument && !['check', 'claude', 'codex'].includes(argument)) {
    notice('Use /updates, /updates check, /updates claude or /updates codex.');
    return false;
  }
  await updates.check(argument === 'check');
  if (!active()) return false;
  const confirm = (entry: RuntimeUpdateEntry) => {
    const journal =
      entry.journal && pendingUpdate(entry.journal) ? entry.journal : undefined;
    const qualify = qualifiable(entry, updates.snapshot);
    if (
      !journal &&
      !qualify &&
      (!entry.check?.available || entry.check.blocked || entry.error)
    )
      return details();
    const target = journal?.previous.version ?? entry.check!.target;
    const installation = journal?.previous ?? entry.check!.installation;
    const launcher = installation.launcher.startsWith(`${homedir()}/`)
      ? `~/${installation.launcher.slice(homedir().length + 1)}`
      : installation.launcher;
    return picker(
      `${journal ? 'Recover' : qualify ? 'Qualify' : 'Update'} ${runtimeLabel(entry.runtime)} ${entry.installation?.version ?? installation.version}?`,
      [
        { id: 'cancel', label: 'Cancel' },
        {
          id: 'confirm',
          label: journal
            ? `Restore ${target}`
            : qualify
              ? `Paid checks on ${installation.version}`
              : `${target} + paid checks`,
        },
      ],
      async (id) => {
        details();
        if (id !== 'confirm') return false;
        if (journal) await updates.recover(journal);
        else await updates.apply(entry.check!, { accountUsage: true });
        return true;
      },
      false,
      launcher,
    );
  };
  if (argument === 'check') return details();
  if (argument) {
    const entry = updates.snapshot.entries.find(
      (entry) => entry.runtime === argument,
    );
    return entry ? confirm(entry) : details();
  }
  return picker(
    'Native runtime updates',
    [
      { id: 'details', label: 'Version and verification details' },
      ...updates.snapshot.entries.map((entry) => ({
        id: entry.runtime,
        label: updateChoice(entry, updates.snapshot),
      })),
    ],
    (id) => {
      const entry = updates.snapshot.entries.find(
        (entry) => entry.runtime === id,
      );
      return entry ? confirm(entry) : details();
    },
  );
}
