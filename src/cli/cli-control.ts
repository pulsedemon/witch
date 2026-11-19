import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { aborted, errorMessage } from '../errors.js';
import { claudeArguments } from './cli-familiar.js';
import { codexArguments } from './cli-codex-familiar.js';
import {
  coordinationActionSchema,
  selectionStatus,
} from '../core/coordination/coordination-state.js';
import { callControl, controlBindingSchema } from '../persistence/control.js';
import type { ControlBinding, ControlOutcome } from '../persistence/control.js';
import { quote } from '../shell.js';
import { oneLine } from '../ui/links.js';
import { peerStatus } from '../ui/commands/peers.js';

/** `<runtime>:<model>`, splitting at the first colon so a model ID keeps its own. */
function choice(text: string | undefined) {
  if (text === undefined) return undefined;

  const colon = text.indexOf(':');

  if (colon <= 0 || colon === text.length - 1)
    throw new Error('Name a runtime and model as <runtime>:<model>.');

  return { runtime: text.slice(0, colon), model: text.slice(colon + 1) };
}

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
  reference: { type: 'string', multiple: true },
  'select-next': { type: 'string' },
  'cancel-selection': { type: 'string' },
  recommend: { type: 'string' },
  selection: { type: 'string' },
  ask: { type: 'string' },
  answer: { type: 'string' },
  message: { type: 'string' },
  'peer-request': { type: 'string' },
  pause: { type: 'boolean' },
  to: { type: 'string', multiple: true },
  resume: { type: 'string' },
  'pause-status': { type: 'string' },
  route: { type: 'string' },
  of: { type: 'string' },
  named: { type: 'string' },
  json: { type: 'boolean' },
  'familiar-claude': { type: 'string' },
  'familiar-codex': { type: 'string' },
  'report-file': { type: 'string' },
  'without-mcp': { type: 'boolean' },
  spawn: { type: 'string' },
} as const;

const bindingOptions = [
  'control-dir',
  'control-conversation',
  'control-activation',
] as const;

/** in the order the "choose exactly one" refusal lists them. */
const actionOptions = [
  'peers',
  'claim',
  'release',
  'select-next',
  'recommend',
  'cancel-selection',
  'ask',
  'answer',
  'peer-request',
  'pause',
  'resume',
  'pause-status',
  'route',
] as const;

function bindingOf(values: {
  [name in (typeof bindingOptions)[number]]?: string;
}) {
  return controlBindingSchema.parse({
    directory: values['control-dir'] && resolve(values['control-dir']),
    conversation: values['control-conversation'],
    activation: values['control-activation'],
  });
}

type CommandValues = ReturnType<
  typeof parseArgs<{ options: typeof options }>
>['values'];

function familiarMode(
  values: CommandValues,
  positionals: string[],
  args: string[],
  separator: number,
) {
  const runtime = values['familiar-codex'] !== undefined ? 'codex' : 'claude';
  const option = runtime === 'codex' ? 'familiar-codex' : 'familiar-claude';
  const label = runtime === 'codex' ? 'Codex' : 'Claude';

  const allowed = new Set([
    ...bindingOptions,
    option,
    'report-file',
    ...(runtime === 'codex' ? ['without-mcp'] : []),
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

  const binding = bindingOf(values);
  (runtime === 'codex' ? codexArguments : claudeArguments)(positionals);

  return {
    runtime,
    binding,
    name: values[option].trim(),
    reportFile: resolve(values['report-file']),
    args: positionals,
    withoutMcp: values['without-mcp'] === true,
  };
}

function controlAction(
  name: (typeof actionOptions)[number],
  values: CommandValues,
): unknown {
  switch (name) {
    case 'peers':
      return { kind: 'peers' };

    case 'claim':
      return {
        kind: 'claim',
        input: {
          reference: values.claim,
          summary: values.summary,
          aliases: values.alias,
        },
      };

    case 'recommend':
      return {
        kind: 'recommend',
        selection: values.selection,
        input: {
          reference: values.recommend,
          summary: values.summary,
          aliases: values.alias,
        },
      };

    case 'release':
      return values.reference
        ? {
            kind: 'release-references',
            claim: values.release,
            references: values.reference,
          }
        : { kind: 'release', claim: values.release };

    case 'select-next':
      return { kind: 'select-next', turn: values['select-next'] };

    case 'cancel-selection':
      return {
        kind: 'cancel-selection',
        selection: values['cancel-selection'],
      };

    case 'ask':
      return { kind: 'ask', claim: values.ask, message: values.message };

    case 'answer':
      return {
        kind: 'answer',
        request: values.answer,
        message: values.message,
      };

    case 'peer-request':
      return { kind: 'peer-request', request: values['peer-request'] };

    case 'pause':
      return { kind: 'pause', to: values.to };

    case 'resume':
      return { kind: 'resume', pause: values.resume };

    case 'pause-status':
      return { kind: 'pause-status', pause: values['pause-status'] };

    case 'route':
      return {
        kind: 'route',
        work: values.route,
        of: choice(values.of),
        named: choice(values.named),
      };

    default:
      return name satisfies never;
  }
}

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
    values['report-file'] !== undefined ||
    values['without-mcp'] !== undefined;

  if (reporting) {
    return {
      ...parsed,
      control: undefined,
      familiar: familiarMode(values, positionals, args, separator),
      spawn: undefined,
    };
  }

  // the tabs start Witch on the default state directory, so nothing else applies
  if (values.spawn !== undefined) {
    if (!/^[1-9]\d*$/.test(values.spawn))
      throw new Error('--spawn needs a positive number of worktrees.');

    if (positionals.length || Object.keys(values).length > 1)
      throw new Error('--spawn cannot include prompts or other options.');

    return {
      ...parsed,
      control: undefined,
      familiar: undefined,
      spawn: Number(values.spawn),
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
    ...bindingOptions,
    ...actionOptions,
    'summary',
    'alias',
    'reference',
    'selection',
    'message',
    'to',
    'of',
    'named',
    'json',
  ] as const;

  if (!controls.some((name) => values[name] !== undefined))
    return {
      ...parsed,
      control: undefined,
      familiar: undefined,
      spawn: undefined,
    };

  const flags = actionOptions.map((name) => `--${name}`);

  if (values.reference && values.release === undefined)
    throw new Error('--reference requires --release.');

  const actions = actionOptions.filter((name) => values[name] !== undefined);

  if (actions.length !== 1)
    throw new Error(
      `Choose exactly one control action: ${flags.slice(0, -1).join(', ')} or ${flags.at(-1)}.`,
    );

  if (!values.pause && values.to) throw new Error('--to requires --pause.');

  if (
    values.route === undefined &&
    (values.of !== undefined || values.named !== undefined)
  )
    throw new Error('--of and --named require --route.');

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

  if (bindingOptions.some((name) => !values[name]))
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

  const binding = bindingOf(values);

  const action = coordinationActionSchema.parse(
    controlAction(actions[0]!, values),
  );

  return {
    ...parsed,
    control: { binding, action, json: !!values.json },
    familiar: undefined,
    spawn: undefined,
  };
}

/** source launches need absolute loader and config paths when a tool changes directories. */
export function controlPrefix(binding: ControlBinding, entry: string): string {
  const source = /\.tsx?$/.test(entry);

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

    case 'references-released':
      return `Released references: ${outcome.references.map(oneLine).join(', ')}\n${outcome.claim ? `Remaining references: ${outcome.claim.references.map(oneLine).join(', ')}\nClaim id: ${outcome.claim.id}` : 'Task released.'}`;

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

    case 'pause':
      return [
        `Pause ${outcome.pause.id} from ${oneLine(outcome.pause.from)}`,
        ...Object.entries(outcome.statuses).map(
          ([conversation, status]) => `${oneLine(conversation)}: ${status}`,
        ),
      ].join('\n');

    case 'route':
      return [
        ...outcome.routes.map(
          ({ runtime, model, reason }) =>
            `Route: ${runtime} ${model}\nReason: ${reason}`,
        ),
        ...(outcome.folded ?? []).map(
          ({ runtime, model, reason, from }) =>
            `Passed over: ${from} for ${runtime} ${model}\nReason: ${reason}`,
        ),
      ].join('\n');

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
                `Selection ${snapshot.ownSelection.ticket.id}: ${selectionStatus(snapshot.ownSelection)}`,
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
          if (!aborted(error)) throw error;
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
