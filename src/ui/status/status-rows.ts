import { basename } from 'node:path';
import stringWidth from 'string-width';
import type {
  AccountReading,
  Funding,
  Limit,
  Usage,
} from '../../agents/types.js';
import {
  creditCapacity,
  current,
  fundingText,
  untilReset,
} from '../../core/runtime/usage.js';
import type { Repository } from '../../core/repository/repository.js';
import { hyperlink, linkify, oneLine, plain } from '../links.js';
import { colors, piped } from '../theme.js';
import { wrapLines } from '../wrap.js';

export interface Account {
  id: string;
  /** `undefined` until a reading arrives. */
  reading?: AccountReading;
}

export interface Status {
  model?: string;
  effort?: string;
  usage: Usage;
  /** absent while the sidebar shows every runtime's account reading. */
  account?: AccountReading;
  /** other runtimes in installed order. */
  others?: readonly Account[];
  /** epoch milliseconds. */
  openedAt?: number;
  cwd: string;
  repository?: Repository;
}

const white = colors.whiteBright;

export const tokenCount = new Intl.NumberFormat('en', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

/** white until 40%, then warming through yellow to red by 60%. */
function bar(percent: number): string {
  const filled = Math.min(10, Math.floor((percent * 10) / 100));
  const cells = '█'.repeat(filled) + '░'.repeat(10 - filled);

  if (percent >= 60) return colors.rgb(255, 0, 0)(cells);

  if (percent >= 50)
    return colors.rgb(
      255,
      255 - Math.floor(((percent - 50) * 255) / 10),
      0,
    )(cells);

  if (percent >= 40)
    return colors.rgb(
      255,
      255,
      255 - Math.floor(((percent - 40) * 255) / 10),
    )(cells);

  return cells;
}

function duration(milliseconds: number): string {
  const minutes = Math.floor(milliseconds / 60_000);
  const hours = Math.floor(minutes / 60);

  return hours > 0
    ? `${hours}H${String(minutes % 60).padStart(2, '0')}M`
    : `${minutes}M`;
}

/** a window that isn't current shows dim, with its age in place of the reset when `reset` is set. */
function windowText(limit: Limit, now: number, reset: boolean): string {
  const percent = Math.round(limit.percent);

  if (!current(limit, now))
    return colors.dim(
      `${limit.window} ${percent}%${reset ? `  ${duration(now - limit.observedAt)} OLD` : ''}`,
    );

  const left = reset ? untilReset(limit.resetsAt, now) : '';

  return `${limit.window} ${limitColor(percent)(`${percent}%`)}${left && ` ${left}`}`;
}

function fundingRow(funding: Funding, now: number): string {
  const text = plain(fundingText(funding));

  return current(funding, now)
    ? text
    : colors.dim(`${text} ${duration(now - funding.observedAt)} OLD`);
}

function spendingBlocked(
  account: AccountReading | undefined,
  now: number,
): boolean {
  return (
    account?.funding?.kind === 'credits' &&
    (account.funding.available || account.funding.unlimited) &&
    creditCapacity(account, now) === 'unavailable'
  );
}

function hasFunding({ account, others }: Status): boolean {
  return !!(
    account?.funding || others?.some(({ reading }) => reading?.funding)
  );
}

export function accountRows(
  account: AccountReading | undefined,
  now: number,
  reset: boolean,
): string[] {
  const rows =
    account?.limits.map((limit) => windowText(limit, now, reset)) ?? [];

  if (account?.funding) rows.push(fundingRow(account.funding, now));

  if (spendingBlocked(account, now)) rows.push('credit spending blocked');

  return rows.length ? rows : ['?'];
}

function limitColor(percent: number): (text: string) => string {
  return percent >= 90
    ? colors.red
    : percent >= 70
      ? colors.yellow
      : (text) => text;
}

function git(repository: Repository): string {
  const { branch, ahead, behind, staged, modified, conflicts, untracked } =
    repository;

  return [
    plain(branch),
    ...(ahead ? [`↑${ahead}`] : []),
    ...(behind ? [`↓${behind}`] : []),
    ...(staged ? [`+${staged}`] : []),
    ...(modified ? [`~${modified}`] : []),
    ...(conflicts ? [`!${conflicts}`] : []),
    ...(untracked ? [`?${untracked}`] : []),
  ].join(' ');
}

/**
 * a conflict outlasts a failed read of its pull request, which shows it without checks. a branch with neither shows
 * the pull request of the branch the checkout left last.
 */
function pullRequest({
  pullRequest: own,
  conflict,
  followed,
}: Repository): string | undefined {
  const request = own ?? (conflict ? undefined : followed?.[0]);
  const shown = request ?? conflict?.pullRequest;

  if (!shown) return;

  const link = hyperlink(`PR#${shown.number}`, shown.url, '/');

  if (shown.state === 'MERGED') return `${link} ${colors.magenta('MERGED')}`;

  if (shown.state === 'CLOSED') return `${link} CLOSED`;

  return [
    link,
    ...(request
      ? [
          request.checks === 'passing'
            ? colors.green('✓')
            : request.checks === 'failing'
              ? colors.red('✗')
              : request.checks === 'none'
                ? colors.dim('NO CHECKS')
                : colors.yellow('…'),
        ]
      : []),
    ...(conflict ? [colors.red('CONFLICT')] : []),
  ].join(' ');
}

/** limited footers keep the live balance and spending denial ahead of other account details. */
export function statusLines(
  status: Status,
  now: number,
  width = Infinity,
  maxRows = Infinity,
): [string, string, ...string[]] {
  const { usage, repository } = status;
  const context = Math.floor(usage.context ?? 0);

  const capacity =
    usage.contextWindow === undefined
      ? ''
      : ` (${tokenCount.format(usage.contextWindow)})`;

  const others = (status.others ?? []).map(({ id, reading }) =>
    [id.toUpperCase(), ...accountRows(reading, now, false)].join(' '),
  );

  const first = (reset: boolean) => {
    const limits = status.account
      ? accountRows(status.account, now, reset).join(' ')
      : '';

    return piped([
      white(plain(status.model || '?').toUpperCase()),
      plain(status.effort || 'default').toUpperCase(),
      // a conversation can open after the clock was last read
      duration(Math.max(0, now - (status.openedAt ?? now))),
      ...(limits ? [limits] : []),
      ...others,
    ]);
  };

  const full = first(true);
  const compact = stringWidth(full) > width ? first(false) : full;
  const funded = hasFunding(status);
  const request = repository && pullRequest(repository);

  const lines: [string, string, ...string[]] = [
    compact,
    piped([
      `${white('CTX')} ${context}%${capacity} ${bar(context)}`,
      white(hyperlink(oneLine(basename(status.cwd)), status.cwd, status.cwd)),
      ...(repository ? [white(git(repository))] : []),
      ...(request ? [white(request)] : []),
      `${usage.lines?.added ?? 0}+/${usage.lines?.removed ?? 0}-`,
    ]),
  ];

  if (funded) lines.splice(0, 1, ...wrapLines(compact, width, true));

  if (funded && lines.length > maxRows) {
    const live = status.account?.funding;

    const text = live
      ? fundingText(live) +
        (current(live, now) ? '' : ' OLD') +
        (spendingBlocked(status.account, now) ? ' BLOCKED' : '')
      : accountRows(status.account, now, false).join(' ');

    const balance = wrapLines(plain(text), width, true);

    const compact = [
      ...balance,
      ...wrapLines('Details: /delegation', width, true),
    ] as [string, string, ...string[]];

    if (compact.length < maxRows)
      compact.unshift(
        piped([
          plain(status.model || '?').toUpperCase(),
          plain(status.effort || 'default').toUpperCase(),
        ]),
      );

    return compact;
  }

  return lines;
}

/** errors and account details share the footer budget without taking the composer's reserved rows. */
export function statusFooter(
  status: Status,
  now: number,
  {
    width,
    height,
    error,
    bodyRows,
    headerRows = 1,
  }: {
    width: number;
    height: number;
    error?: string;
    bodyRows: number;
    headerRows?: number;
  },
): { lines: string[]; errors: string[] } {
  const available = Math.max(0, height - headerRows - bodyRows);

  if (!available) return { lines: [], errors: [] };

  const funded = hasFunding(status);

  const minimumStatusRows = funded
    ? statusLines(status, now, width, 2).length
    : 2;

  const errorLimit = Math.max(
    0,
    Math.min(Math.floor(height / 3), available - minimumStatusRows),
  );

  const errorLines = error
    ? wrapLines(linkify(plain(error), status.cwd), width)
    : [];

  const errors =
    errorLimit === 0
      ? []
      : errorLines.length > errorLimit
        ? [
            ...errorLines.slice(0, errorLimit - 1),
            `+${errorLines.length - errorLimit + 1} more rows`,
          ]
        : errorLines;

  const lines = statusLines(
    status,
    now,
    width,
    Math.max(2, available - errors.length),
  );

  return {
    errors,
    lines: lines.length <= available - errors.length ? lines : [],
  };
}
