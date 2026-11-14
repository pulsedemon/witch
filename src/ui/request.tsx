import { useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { z } from 'zod';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { fullFormats } from 'ajv-formats/dist/formats.js';
import type { UserRequest, UserResponse } from '../agents/types.js';
import { errorMessage } from '../errors.js';
import { Input } from './input.js';
import { useKeysReady } from './keys-ready.js';
import { linkify, plain } from './links.js';
import { useLiveState } from './live-state.js';
import { piped } from './theme.js';
import { canExpandDiff, diffExpansionHint, diffRows } from './diff.js';
import { wrapLines } from './wrap.js';
import { ScrollPage } from './scroll-page.js';

interface Props {
  request: UserRequest;
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
  const [scroll, setScroll] = useState(0);
  const [error, setError] = useState('');
  const [full, setFull] = useState(false);
  const ready = useKeysReady(active);
  const question = request.questions?.[questionIndex];
  const options = question?.options ?? approvals.map(({ label }) => label);
  const expandable = !!request.diff && canExpandDiff(request.diff);
  const bodyHeight = Math.max(2, height - 7 - Number(expandable));
  const fields = `${request.detail}${request.schema ? `\n\nRequested fields:\n${JSON.stringify(request.schema, null, 2)}` : ''}`;

  const detail = question
    ? `${question.title}\n\n${options.map((option, index) => `${index === selection ? '›' : ' '} ${index + 1}. ${option}`).join('\n')}`
    : `${request.title}\n\n${request.url ?? ''}\n${fields}`;

  const lines = useMemo(() => {
    const wrap = (text: string) => wrapLines(linkify(text, cwd), width);

    if (question || !request.diff?.length) return wrap(detail);

    return [
      ...wrap(`${request.title}\n\n${request.url ?? ''}`),
      ...diffRows(request.diff, width, cwd, full).flat(),
      '',
      ...wrap(fields),
    ];
  }, [request, detail, fields, question, width, cwd, full]);

  useInput((input, key) => {
    if (!active || key.eventType === 'release') return;

    if (key.ctrl && input === 'o' && expandable) {
      setFull((previous) => !previous);

      setScroll(0);

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

        setScroll(0);
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
    <Box flexDirection="column" height={height}>
      <Text bold color="yellow">
        {question
          ? `Question ${questionIndex + 1}/${request.questions!.length}`
          : request.kind === 'approval'
            ? 'Approval required'
            : 'Input requested'}
      </Text>
      <ScrollPage
        lines={lines}
        active={active}
        height={bodyHeight}
        scroll={scroll}
        setScroll={setScroll}
      />
      {expandable && <Text dimColor>{diffExpansionHint(full)}</Text>}
      {request.kind === 'approval' ? (
        <Box flexDirection="column">
          <Text>
            {options
              .map(
                (label, index) =>
                  `${index === selection ? '› ' : '  '}${label}`,
              )
              .join('   ')}
          </Text>
          <Text dimColor>
            {piped([
              '↑/↓ CHOOSE',
              'ENTER CONFIRM',
              'y ALLOW',
              'n DECLINE',
              'ESC DECLINE',
              'CTRL+C STOP TURN',
            ])}
          </Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          <Text dimColor>
            {question
              ? question.multiple
                ? 'Type an answer or option numbers separated by commas.'
                : 'Type an answer or option number.'
              : request.url
                ? 'Click the URL, then press Enter when finished.'
                : 'Enter a JSON object with the requested fields.'}
          </Text>
          <Input
            key={questionIndex}
            width={width}
            height={3}
            active={active && ready}
            secret={question?.secret}
            multiline={!question}
            placeholder={question ? 'Your answer' : '{}'}
            onSubmit={submit}
          />
          <Text dimColor>{piped(['ESC DECLINE', 'CTRL+C STOP TURN'])}</Text>
        </Box>
      )}
      {error && <Text color="red">{error}</Text>}
    </Box>
  );
}
