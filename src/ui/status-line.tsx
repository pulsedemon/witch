import { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { basename } from 'node:path';
import type { Usage } from '../agents/types.js';
import type { Repository } from '../core/repository.js';
import { hyperlink, oneLine, plain } from './links.js';
import { colors, piped } from './theme.js';

export interface Status {
  model?: string;
  effort?: string;
  usage: Usage;
  /** epoch milliseconds. */
  openedAt?: number;
  cwd: string;
  repository?: Repository;
}

const white = colors.whiteBright;
const tokenCount = new Intl.NumberFormat('en', {
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

/** what a percentage alone can't say: how soon the window resets. */
function untilReset(resetsAt: number | undefined, now: number): string {
  const left = Math.floor((resetsAt ?? 0) - now / 1000);
  if (left <= 0) return '';
  if (left >= 86_400)
    return ` ${Math.floor(left / 86_400)}d${Math.floor((left % 86_400) / 3600)}h`;
  if (left >= 3600)
    return ` ${Math.floor(left / 3600)}h${Math.floor((left % 3600) / 60)}m`;
  return ` ${Math.floor(left / 60)}m`;
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

function pullRequest({ pullRequest: request }: Repository): string | undefined {
  if (!request) return;
  const link = hyperlink(`PR#${request.number}`, request.url, '/');
  if (request.state === 'MERGED') return `${link} ${colors.magenta('MERGED')}`;
  if (request.state === 'CLOSED') return `${link} CLOSED`;
  return `${link} ${
    request.checks === 'passing'
      ? colors.green('✓')
      : request.checks === 'failing'
        ? colors.red('✗')
        : colors.yellow('…')
  }`;
}

export function statusLines(status: Status, now: number): [string, string] {
  const { usage, repository } = status;
  const context = Math.floor(usage.context ?? 0);
  const capacity =
    usage.contextWindow === undefined
      ? ''
      : ` (${tokenCount.format(usage.contextWindow)})`;
  const limits = (usage.limits ?? [])
    .map(({ window, percent, resetsAt }) => {
      const rounded = Math.round(percent);
      return `${window} ${limitColor(rounded)(`${rounded}%`)}${untilReset(resetsAt, now)}`;
    })
    .join(' ');
  const request = repository && pullRequest(repository);
  return [
    piped([
      white(plain(status.model || '?').toUpperCase()),
      plain(status.effort || 'default').toUpperCase(),
      white(`$${(usage.cost ?? 0).toFixed(2)}`),
      // a conversation can open after the clock was last read
      duration(Math.max(0, now - (status.openedAt ?? now))),
      ...(limits ? [limits] : []),
    ]),
    piped([
      `${white('CTX')} ${context}%${capacity} ${bar(context)}`,
      white(hyperlink(oneLine(basename(status.cwd)), status.cwd, status.cwd)),
      ...(repository ? [white(git(repository))] : []),
      ...(request ? [white(request)] : []),
      `${usage.lines?.added ?? 0}+/${usage.lines?.removed ?? 0}-`,
    ]),
  ];
}

/** redrawn every 5 seconds, as Claude Code refreshes a status line, so the duration and resets keep time. */
export function StatusLine(status: Status) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);
  return (
    <Box flexDirection="column" height={2} paddingX={1}>
      {statusLines(status, now).map((line, row) => (
        <Text key={row} wrap="truncate-end">
          {line}
        </Text>
      ))}
    </Box>
  );
}
