import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { errorMessage } from './agents/stderr.js';
import { claudeArguments } from './cli-familiar.js';
import { codexArguments } from './cli-codex-familiar.js';
import { coordinationActionSchema } from './core/coordination-state.js';
import { callControl, controlBindingSchema } from './persistence/control.js';
import type { ControlBinding, ControlOutcome } from './persistence/control.js';
import { quote } from './shell.js';
import { oneLine } from './ui/links.js';
import { peerStatus } from './ui/peers.js';

const options = {
  'state-dir': { type: 'string' },
  continue: { type: 'boolean', short: 'c' },
  help: { type: 'boolean', short: 'h' },
  'recover-directory': { type: 'string' },
  apply: { type: 'boolean' },
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
  ask: { type: 'string' },
  answer: { type: 'string' },
  message: { type: 'string' },
  'peer-request': { type: 'string' },
  json: { type: 'boolean' },
  'familiar-claude': { type: 'string' },
  'familiar-codex': { type: 'string' },
  'report-file': { type: 'string' },
} as const;

export function parseCommand(args = process.argv.slice(2)) {
  const separator = args.indexOf('--');
  const parsed = parseArgs({
    args,
    options,
    allowPositionals: true,
    strict: true,
  });
  const { values, positionals } = parsed;
  const reporting =
    values['familiar-claude'] !== undefined ||
    values['familiar-codex'] !== undefined ||
    values['report-file'] !== undefined;
  if (reporting) {
    const runtime = values['familiar-codex'] !== undefined ? 'codex' : 'claude';
    const option = runtime === 'codex' ? 'familiar-codex' : 'familiar-claude';
    const label = runtime === 'codex' ? 'Codex' : 'Claude';
    const allowed = new Set([
      'control-dir',
      'control-conversation',
      'control-activation',
      option,
      'report-file',
    ]);
    if (
      Object.keys(values).some((key) => !allowed.has(key)) ||
      separator < 0 ||
      positionals.length !== args.length - separator - 1
    )
      throw new Error(
        `${label} familiar mode requires -- before native arguments and cannot include other Witch options or prompts.`,
      );
    if (!values[option]?.trim() || !values['report-file'])
      throw new Error(
        `${label} familiar mode requires a task name and --report-file.`,
      );
    const binding = controlBindingSchema.parse({
      directory: values['control-dir'] && resolve(values['control-dir']),
      conversation: values['control-conversation'],
      activation: values['control-activation'],
    });
    (runtime === 'codex' ? codexArguments : claudeArguments)(positionals);
    return {
      ...parsed,
      control: undefined,
      familiar: {
        runtime,
        binding,
        name: values[option].trim(),
        reportFile: resolve(values['report-file']),
        args: positionals,
      },
    };
  }
  if (values.apply && values['recover-directory'] === undefined)
    throw new Error('--apply requires --recover-directory.');
  if (
    values['recover-directory'] !== undefined &&
    (!values['recover-directory'] ||
      positionals.length ||
      values.continue ||
      values.help)
  )
    throw new Error(
      '--recover-directory needs a saved directory and cannot include prompts, --continue or --help.',
    );
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
    'ask',
    'answer',
    'message',
    'peer-request',
    'json',
  ] as const;
  if (!controls.some((name) => values[name] !== undefined))
    return { ...parsed, control: undefined, familiar: undefined };
  const actions = [
    !!values.peers,
    values.claim !== undefined,
    values.release !== undefined,
    values['select-next'] !== undefined,
    values['cancel-selection'] !== undefined,
    values.recommend !== undefined,
    values.ask !== undefined,
    values.answer !== undefined,
    values['peer-request'] !== undefined,
  ].filter(Boolean).length;
  if (actions !== 1)
    throw new Error(
      'Choose exactly one control action: --peers, --claim, --release, --select-next, --recommend, --cancel-selection, --ask, --answer or --peer-request.',
    );
  if (
    positionals.length ||
    values.continue ||
    values.help ||
    values['recover-directory'] !== undefined ||
    values['state-dir'] !== undefined
  )
    throw new Error(
      'Control commands cannot include prompts, --continue, --help, --state-dir or --recover-directory.',
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
  const asking = values.ask !== undefined || values.answer !== undefined;
  if (asking && values.message === undefined)
    throw new Error('--ask and --answer require --message.');
  if (!asking && values.message !== undefined)
    throw new Error('--message requires --ask or --answer.');
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
        : values.ask !== undefined
          ? { kind: 'ask', claim: values.ask, message: values.message }
          : values.answer !== undefined
            ? {
                kind: 'answer',
                request: values.answer,
                message: values.message,
              }
            : values['peer-request'] !== undefined
              ? { kind: 'peer-request', request: values['peer-request'] }
              : values['select-next'] !== undefined
                ? { kind: 'select-next', turn: values['select-next'] }
                : values['cancel-selection'] !== undefined
                  ? {
                      kind: 'cancel-selection',
                      selection: values['cancel-selection'],
                    }
                  : { kind: 'release', claim: values.release },
  );
  return {
    ...parsed,
    control: { binding, action, json: !!values.json },
    familiar: undefined,
  };
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
    case 'familiar-registered':
    case 'familiar-pending':
    case 'familiar-updated':
    case 'familiar-request-pending':
    case 'familiar-response':
      return outcome.kind;
    case 'claimed':
      return `${outcome.claim.suggestion ? 'Suggested' : 'Claimed'}: ${oneLine(outcome.claim.summary)}\nClaim id: ${outcome.claim.id}${outcome.warning ? `\nWarning: ${outcome.warning}` : ''}`;
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
    case 'peer-request': {
      const { request, status } = outcome;
      return [
        `Peer request ${request.id} from ${oneLine(request.from)} to ${oneLine(request.to)} about ${oneLine(request.reference)}: ${status}`,
        `Request: ${oneLine(request.message)}`,
        ...(request.answer
          ? [`Answer: ${oneLine(request.answer.message)}`]
          : status === 'attempted'
            ? [
                "The owner's Witch took this request for its one answer turn; no answer is recorded yet.",
              ]
            : status === 'undeliverable'
              ? ['The owner no longer holds that claim.']
              : []),
      ].join('\n');
    }
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
