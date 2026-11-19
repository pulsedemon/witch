import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { z } from 'zod';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { fullFormats } from 'ajv-formats/dist/formats.js';
import type { UserRequest, UserResponse } from '../agents/types.js';
import { errorMessage } from '../errors.js';
import type { Preview as PreviewOwner } from '../core/preview.js';
import { Preview } from './Preview.js';
import { usePreview } from './usePreview.js';
import { previewLayout } from './preview-layout.js';
import { Input } from './input/Input.js';
import { useKeysReady } from './input/useKeysReady.js';
import { linkify, plain } from './links.js';
import { useLiveState } from './useLiveState.js';
import { piped } from './theme.js';
import {
  canExpandDiff,
  diffExpansionHint,
  prepareDiff,
} from './transcript/diff.js';
import { wrapLines, wrapSourceLines } from './wrap.js';
import { ScrollPage } from './ScrollPage.js';
import { pageAnchorAt, pageRowOf, pageStart } from './scroll-page-layout.js';
import type { PagePosition } from './scroll-page-layout.js';

interface Props {
  request: UserRequest;
  preview?: PreviewOwner;
  active?: boolean;
  width: number;
  height: number;
  cwd: string;
  respond(response: UserResponse): void;
}

const approvals = [
  { label: 'Allow once', decision: 'accept' },
  { label: 'Decline', decision: 'decline' },
  { label: 'Cancel turn', decision: 'cancel' },
] as const;

export function Request({
  request,
  preview,
  width,
  height,
  cwd,
  respond,
  active = true,
}: Props) {
  const [selection, selectionRef, setSelection] = useLiveState(0);
  const [questionIndex, questionIndexRef, setQuestionIndex] = useLiveState(0);
  // never rendered, so a ref alone carries answers between keys
  const answers = useRef<Record<string, string[]>>({});
  const [scroll, setScroll] = useState<PagePosition>(pageStart);
  const followedSelection = useRef({ question: -1, option: -1 });
  const [error, setError] = useState('');
  const [full, setFull] = useState(false);
  const ready = useKeysReady(active);
  const previewSnapshot = usePreview(preview);
  const question = request.questions?.[questionIndex];
  const options = question?.options ?? approvals.map(({ label }) => label);
  const expandable = !!request.diff && canExpandDiff(request.diff);
  const approval = request.kind === 'approval';

  const inputHeight = approval
    ? 0
    : Math.min(3, Math.max(1, Math.floor(height / 4)));

  const controlRows = approval ? 1 : inputHeight;
  const headingRows = Number(height >= controlRows + 2);
  const errorLines = error ? wrapLines(error, width) : [];

  const errorRows = Math.min(
    errorLines.length,
    Math.max(0, height - controlRows - headingRows),
  );

  const hints = [
    ...(expandable ? [diffExpansionHint(full)] : []),
    approval
      ? piped([
          '↑/↓ CHOOSE',
          'ENTER CONFIRM',
          'y ALLOW',
          'n DECLINE',
          'ESC DECLINE',
          'CTRL+C STOP TURN',
        ])
      : question
        ? question.multiple
          ? 'Type an answer or option numbers separated by commas.'
          : 'Type an answer or option number.'
        : request.url
          ? 'Click the URL, then press Enter when finished.'
          : 'Enter a JSON object with the requested fields.',
    ...(!approval ? [piped(['ESC DECLINE', 'CTRL+C STOP TURN'])] : []),
  ].flatMap((line) => wrapLines(line, width));

  const hintRows = Math.min(
    hints.length,
    Math.max(0, height - controlRows - headingRows - errorRows - 2),
  );

  const detailBudget = Math.min(
    height - controlRows - headingRows - errorRows - hintRows,
    Math.max(2, height - 7 - Number(expandable)),
  );

  const labels = options
    .map((label, index) => `${index === selection ? '› ' : '  '}${label}`)
    .join('   ');

  const choices =
    wrapLines(labels, width).length > 1
      ? width < 4
        ? wrapLines(options[selection] ?? '', width)[0]
        : `› ${options[selection] ?? ''}`
      : labels;

  const fields = `${request.detail}${request.schema ? `\n\nRequested fields:\n${JSON.stringify(request.schema, null, 2)}` : ''}`;

  const detail = question
    ? `${question.title}\n\n${options.map((option, index) => `${index === selection ? '›' : ' '} ${index + 1}. ${option}`).join('\n')}`
    : `${request.title}\n\n${request.url ?? ''}\n${fields}`;

  const differences = request.diff;

  const renderDiff = useMemo(
    () =>
      differences?.length ? prepareDiff(differences, cwd, full) : undefined,
    [differences, cwd, full],
  );

  const lines = useMemo(() => {
    const wrap = (text: string) => wrapSourceLines(linkify(text, cwd), width);

    if (question || !renderDiff) return wrap(detail);

    return [
      ...wrap(`${request.title}\n\n${request.url ?? ''}`),
      ...renderDiff(width),
      [{ text: '', offset: 0 }],
      ...wrap(fields),
    ];
  }, [request, detail, fields, question, width, cwd, renderDiff]);

  const allocation = previewLayout(
    detailBudget,
    lines.reduce((count, line) => count + line.length, 0),
    previewSnapshot?.status,
  );

  const bodyHeight = allocation.body;

  const selectedRow =
    question && options[selection] !== undefined
      ? wrapSourceLines(question.title, width).flat().length +
        1 +
        options
          .slice(0, selection)
          .reduce(
            (rows, option, index) =>
              rows +
              wrapSourceLines(`  ${index + 1}. ${option}`, width).flat().length,
            0,
          )
      : undefined;

  useEffect(() => {
    if (
      selectedRow === undefined ||
      bodyHeight <= 0 ||
      (followedSelection.current.question === questionIndex &&
        followedSelection.current.option === selection)
    )
      return;

    followedSelection.current = { question: questionIndex, option: selection };

    setScroll((current) => {
      const row = pageRowOf(lines, current);

      const next = Math.max(
        0,
        Math.min(selectedRow, Math.max(row, selectedRow - bodyHeight + 1)),
      );

      return next === row ? current : pageAnchorAt(lines, next);
    });
  }, [selectedRow, bodyHeight, questionIndex, selection, lines]);

  useInput((input, key) => {
    if (!active || key.eventType === 'release') return;

    if (key.ctrl && input === 'o' && expandable) {
      setFull((previous) => !previous);
      setScroll(pageStart);

      return;
    }

    if (!ready) return;

    if (key.escape) {
      respond({ decision: 'decline' });

      return;
    }

    const count = (
      request.questions?.[questionIndexRef.current]?.options ?? approvals
    ).length;

    if (key.upArrow) setSelection(Math.max(0, selectionRef.current - 1));

    if (key.downArrow)
      setSelection(Math.min(count - 1, selectionRef.current + 1));

    if (request.kind === 'approval') {
      const plain = !key.ctrl && !key.meta && !key.super;

      if (plain && input === 'y') respond({ decision: 'accept' });

      if (plain && input === 'n') respond({ decision: 'decline' });

      if (key.return)
        respond({ decision: approvals[selectionRef.current]!.decision });
    }
  });

  const submit = (text: string): boolean => {
    const index = questionIndexRef.current;
    const question = request.questions?.[index];

    if (question) {
      const options = question.options;

      const values = text.trim()
        ? (question.multiple ? text.split(',') : [text]).map((value) => {
            const number = Number(value.trim());

            return Number.isInteger(number) &&
              number > 0 &&
              number <= options.length
              ? options[number - 1]!
              : value.trim();
          })
        : options[selectionRef.current]
          ? [options[selectionRef.current]!]
          : [];

      if (!values.length) return false;

      const next = { ...answers.current, [question.id]: values };

      if (index + 1 === request.questions!.length)
        respond({ decision: 'accept', answers: next });
      else {
        answers.current = next;
        setQuestionIndex(index + 1);
        setSelection(0);
        setScroll(pageStart);
      }

      return true;
    }

    const form = !request.url || !!request.schema;
    const json = text.trim() || '{}';
    let content: UserResponse['content'];

    if (form)
      try {
        content = z.record(z.string(), z.unknown()).parse(JSON.parse(json));
      } catch {
        setError('Enter a JSON object matching the requested fields.');

        return false;
      }

    if (request.schema) {
      // MCP allows any $schema, and Ajv2020 throws on a meta-schema it lacks
      const validator = new Ajv2020({
        strict: false,
        validateSchema: false,
        formats: fullFormats,
      });

      let valid: boolean;

      try {
        valid = validator.validate(request.schema, content);
      } catch (error) {
        // Ajv compiles the schema here, and one it can't compile is the agent's fault, not the answer's
        setError(
          plain(`The request's schema can't be used: ${errorMessage(error)}`),
        );

        return false;
      }

      if (!valid) {
        // Ajv quotes the agent's property names, escapes included
        setError(plain(validator.errorsText()));

        return false;
      }
    }

    respond({ decision: 'accept', content });

    return true;
  };

  return (
    <Box flexDirection="column" height={height} overflow="hidden">
      <Box height={headingRows} flexShrink={0} overflow="hidden">
        <Text bold color="yellow" wrap="truncate-end">
          {question
            ? `Question ${questionIndex + 1}/${request.questions!.length}`
            : approval
              ? 'Approval required'
              : 'Input requested'}
        </Text>
      </Box>
      <Preview
        owner={preview}
        width={width}
        height={allocation.preview}
        request={request.id}
      />
      <ScrollPage
        lines={lines}
        active={active}
        height={bodyHeight}
        scroll={scroll}
        setScroll={setScroll}
      />
      <Box height={hintRows} flexShrink={0} overflow="hidden">
        <Text dimColor>{hints.slice(0, hintRows).join('\n')}</Text>
      </Box>
      {approval ? (
        <Box height={1} flexShrink={0}>
          <Text wrap="truncate-end">{choices}</Text>
        </Box>
      ) : (
        <Input
          key={questionIndex}
          width={width}
          height={inputHeight}
          active={active && ready}
          secret={question?.secret}
          multiline={!question}
          placeholder={question ? 'Your answer' : '{}'}
          onSubmit={submit}
        />
      )}
      <Box height={errorRows} flexShrink={0} overflow="hidden">
        <Text color="red">
          {errorLines.slice(errorLines.length - errorRows).join('\n')}
        </Text>
      </Box>
    </Box>
  );
}
