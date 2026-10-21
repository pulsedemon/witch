import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { errorMessage } from './agents/stderr.js';
import { coordinationActionSchema } from './core/coordination-state.js';
import { callControl, controlBindingSchema } from './persistence/control.js';
import type { ControlBinding, ControlOutcome } from './persistence/control.js';
import { quote } from './shell.js';
import { oneLine } from './ui/links.js';
import { peerStatus } from './ui/peers.js';

export function parseCommand(args = process.argv.slice(2)) {
  const parsed = parseArgs({
    args,
    options: {
      'state-dir': { type: 'string' },
      continue: { type: 'boolean', short: 'c' },
      help: { type: 'boolean', short: 'h' },
      'control-dir': { type: 'string' },
      'control-conversation': { type: 'string' },
      'control-activation': { type: 'string' },
      peers: { type: 'boolean' },
      claim: { type: 'string' },
      summary: { type: 'string' },
      alias: { type: 'string', multiple: true },
      release: { type: 'string' },
      'select-next': { type: 'string' },
      'cancel-selection': { type: 'string' },
      recommend: { type: 'string' },
      selection: { type: 'string' },
      json: { type: 'boolean' },
    },
    allowPositionals: true,
    strict: true,
  });
  const { values, positionals } = parsed;
  const controls = [
    'control-dir',
    'control-conversation',
    'control-activation',
    'peers',
    'claim',
    'summary',
    'alias',
    'release',
    'select-next',
    'cancel-selection',
    'recommend',
    'selection',
    'json',
  ] as const;
  if (!controls.some((name) => values[name] !== undefined))
    return { ...parsed, control: undefined };
  const actions = [
    !!values.peers,
    values.claim !== undefined,
    values.release !== undefined,
    values['select-next'] !== undefined,
    values['cancel-selection'] !== undefined,
    values.recommend !== undefined,
  ].filter(Boolean).length;
  if (actions !== 1)
    throw new Error(
      'Choose exactly one control action: --peers, --claim, --release, --select-next, --recommend or --cancel-selection.',
    );
  if (
    positionals.length ||
    values.continue ||
    values.help ||
    values['state-dir'] !== undefined
  )
    throw new Error(
      'Control commands cannot include prompts, --continue, --help or --state-dir.',
    );
  if (
    !values['control-dir'] ||
    !values['control-conversation'] ||
    !values['control-activation']
  )
    throw new Error(
      'Use the complete control prefix from the current Witch context.',
    );
  if (
    values.claim === undefined &&
    values.recommend === undefined &&
    (values.summary !== undefined || values.alias)
  )
    throw new Error('--summary and --alias require --claim or --recommend.');
  if (values.recommend !== undefined && !values.selection)
    throw new Error('--recommend requires --selection.');
  if (values.recommend === undefined && values.selection !== undefined)
    throw new Error('--selection requires --recommend.');
  const binding = controlBindingSchema.parse({
    directory: resolve(values['control-dir']),
    conversation: values['control-conversation'],
    activation: values['control-activation'],
  });
  const action = coordinationActionSchema.parse(
    values.peers
      ? { kind: 'peers' }
      : values.claim !== undefined || values.recommend !== undefined
        ? {
            kind: values.recommend !== undefined ? 'recommend' : 'claim',
            selection: values.selection,
            input: {
              reference: values.recommend ?? values.claim,
              summary: values.summary,
              aliases: values.alias,
            },
          }
        : values['select-next'] !== undefined
          ? { kind: 'select-next', turn: values['select-next'] }
          : values['cancel-selection'] !== undefined
            ? {
                kind: 'cancel-selection',
                selection: values['cancel-selection'],
              }
            : { kind: 'release', claim: values.release },
  );
  return { ...parsed, control: { binding, action, json: !!values.json } };
}

/** source launches need absolute loader and config paths when a tool changes directories. */
export function controlPrefix(binding: ControlBinding, entry: string): string {
  const source = entry.endsWith('.tsx');
  return [
    ...(source
      ? [
          'env',
          `TSX_TSCONFIG_PATH=${resolve(dirname(entry), '..', 'tsconfig.json')}`,
        ]
      : []),
    process.execPath,
    ...(source ? ['--import', import.meta.resolve('tsx')] : []),
    entry,
    '--control-dir',
    binding.directory,
    '--control-conversation',
    binding.conversation,
    '--control-activation',
    binding.activation,
  ]
    .map(quote)
    .join(' ');
}

function describe(outcome: ControlOutcome): string {
  switch (outcome.kind) {
    case 'claimed':
      return `${outcome.claim.suggestion ? 'Suggested' : 'Claimed'}: ${oneLine(outcome.claim.summary)}\nClaim id: ${outcome.claim.id}`;
    case 'selection':
      return `Selection ${outcome.selection.ticket.id}: ${outcome.selection.position === 1 ? 'ready' : `queued #${outcome.selection.position}`}`;
    case 'selection-cancelled':
      return `Selection ${outcome.selection} cancelled.`;
    case 'released':
      return 'Task released.';
    case 'conflict':
      return `${outcome.message}${outcome.owner ? `\nCheckout: ${outcome.owner.cwd}` : ''}\nClaim id: ${outcome.claim.id}`;
    case 'error':
      return outcome.message;
    case 'peers': {
      const snapshot = outcome.snapshot;
      return (
        [
          ...(snapshot.error
            ? [`Coordination unavailable: ${snapshot.error}`]
            : []),
          ...(snapshot.ownClaim
            ? [
                `${snapshot.ownClaim.suggestion ? 'Suggested task' : 'Current task'}: ${oneLine(snapshot.ownClaim.summary)} (${snapshot.ownClaim.id})`,
              ]
            : []),
          ...(snapshot.ownSelection
            ? [
                `Selection ${snapshot.ownSelection.ticket.id}: ${snapshot.ownSelection.position === 1 ? 'choosing' : `queued #${snapshot.ownSelection.position}`}`,
              ]
            : []),
          ...snapshot.peers.map(
            (peer) =>
              `${oneLine(peer.claim?.summary ?? peer.presence.title)} | ${oneLine(peer.presence.agent)} | ${peerStatus(peer)} | ${oneLine(peer.presence.cwd)} | ${oneLine(peer.presence.id)}`,
          ),
          ...snapshot.reservations.map(
            ({ claim, status }) =>
              `${oneLine(claim.summary)} | ${status} | ${oneLine(claim.owner.conversation)} | ${claim.id}`,
          ),
          ...snapshot.unregistered.map(
            (peer) =>
              `${oneLine(peer.title)} | unregistered | ${oneLine(peer.cwd)} | ${oneLine(peer.id)}`,
          ),
        ].join('\n') || 'No other sessions in this project.'
      );
    }
  }
}

export function writeControl(outcome: ControlOutcome, json: boolean): number {
  const code =
    outcome.kind === 'conflict' ? 2 : outcome.kind === 'error' ? 1 : 0;
  const stream = json || code === 0 ? process.stdout : process.stderr;
  stream.write(`${json ? JSON.stringify(outcome) : describe(outcome)}\n`);
  return code;
}

export async function runControl(
  call: NonNullable<ReturnType<typeof parseCommand>['control']>,
): Promise<number> {
  const stopped = new AbortController();
  const stop = () => stopped.abort();
  const waiting = call.action.kind === 'select-next';
  if (waiting) {
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }
  try {
    let outcome: ControlOutcome = await callControl(call.binding, call.action);
    let position: number | undefined;
    let selection: string | undefined;
    while (waiting && outcome.kind === 'selection') {
      const { ticket } = outcome.selection;
      selection = ticket.id;
      if (stopped.signal.aborted || outcome.selection.position === 1) break;
      if (position !== outcome.selection.position) {
        position = outcome.selection.position;
        process.stderr.write(`Selection ${ticket.id}: queued #${position}\n`);
      }
      await delay(1000, undefined, { signal: stopped.signal }).catch(
        (error: unknown) => {
          if (!(error instanceof Error) || error.name !== 'AbortError')
            throw error;
        },
      );
      if (!stopped.signal.aborted)
        outcome = await callControl(call.binding, {
          kind: 'selection-status',
          selection: ticket.id,
        }).catch((error: unknown): ControlOutcome => ({
          kind: 'error',
          message: errorMessage(error),
        }));
    }
    if (stopped.signal.aborted && selection) {
      writeControl(
        await callControl(call.binding, {
          kind: 'cancel-selection',
          selection,
        }),
        call.json,
      );
      return 130;
    }
    return writeControl(outcome, call.json);
  } catch (error) {
    return writeControl(
      { kind: 'error', message: errorMessage(error) },
      call.json,
    );
  } finally {
    if (waiting) {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    }
  }
}
