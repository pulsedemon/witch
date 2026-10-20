import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { errorMessage } from './agents/stderr.js';
import { coordinationActionSchema } from './core/coordination-state.js';
import { callControl, controlBindingSchema } from './persistence/control.js';
import type { ControlBinding, ControlOutcome } from './persistence/control.js';
import { quote } from './shell.js';

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
    'json',
  ] as const;
  if (!controls.some((name) => values[name] !== undefined))
    return { ...parsed, control: undefined };
  const actions = [
    !!values.peers,
    values.claim !== undefined,
    values.release !== undefined,
  ].filter(Boolean).length;
  if (actions !== 1)
    throw new Error('Choose exactly one of --peers, --claim or --release.');
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
    (values.summary !== undefined || values.alias)
  )
    throw new Error('--summary and --alias require --claim.');
  const binding = controlBindingSchema.parse({
    directory: resolve(values['control-dir']),
    conversation: values['control-conversation'],
    activation: values['control-activation'],
  });
  const action = coordinationActionSchema.parse(
    values.peers
      ? { kind: 'peers' }
      : values.claim !== undefined
        ? {
            kind: 'claim',
            input: {
              reference: values.claim,
              summary: values.summary,
              aliases: values.alias,
            },
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
      return `Claimed: ${outcome.claim.summary}\nClaim id: ${outcome.claim.id}`;
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
                `Current task: ${snapshot.ownClaim.summary} (${snapshot.ownClaim.id})`,
              ]
            : []),
          ...snapshot.peers.map(
            ({ presence, claim }) =>
              `${claim?.summary ?? presence.title} | ${presence.agent} | ${presence.phase} | ${presence.cwd} | ${presence.id}`,
          ),
          ...snapshot.reservations.map(
            ({ claim, status }) =>
              `${claim.summary} | ${status} | ${claim.owner.conversation} | ${claim.id}`,
          ),
          ...snapshot.unregistered.map(
            (peer) => `${peer.title} | unregistered | ${peer.cwd} | ${peer.id}`,
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
  try {
    return writeControl(
      await callControl(call.binding, call.action),
      call.json,
    );
  } catch (error) {
    return writeControl(
      { kind: 'error', message: errorMessage(error) },
      call.json,
    );
  }
}
