import { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import wrapAnsi from 'wrap-ansi';
import { z } from 'zod';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { fullFormats } from 'ajv-formats/dist/formats.js';
import type { UserRequest, UserResponse } from '../agents/types.js';
import { Input } from './input.js';
import { linkify } from './links.js';
import { useLiveState } from './live-state.js';

interface Props {
  request: UserRequest;
  width: number;
  height: number;
  cwd: string;
  respond(response: UserResponse): void;
}

const approvalOptions = ['Allow once', 'Decline', 'Cancel turn'];

export function Request({ request, width, height, cwd, respond }: Props) {
  const [selection, selectionRef, setSelection] = useLiveState(0);
  const [questionIndex, questionIndexRef, setQuestionIndex] = useLiveState(0);
  // never rendered, so a ref alone carries answers between keys
  const answers = useRef<Record<string, string[]>>({});
  const [scroll, scrollRef, setScroll] = useLiveState(0);
  const [error, setError] = useState('');
  // keys meant for the composer must not answer a request that just appeared
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setReady(true), 500);
    return () => clearTimeout(timer);
  }, []);
  const question = request.questions?.[questionIndex];
  const options = question?.options ?? approvalOptions;
  const bodyHeight = Math.max(2, height - 7);
  const detail = question
    ? `${question.title}\n\n${options.map((option, index) => `${index === selection ? '›' : ' '} ${index + 1}. ${option}`).join('\n')}`
    : `${request.title}\n\n${request.url ?? ''}\n${request.detail}${request.schema ? `\n\nRequested fields:\n${JSON.stringify(request.schema, null, 2)}` : ''}`;
  const lines = wrapAnsi(linkify(detail, cwd), width - 2, {
    hard: true,
    trim: false,
  }).split('\n');
  const top = Math.min(scroll, Math.max(0, lines.length - bodyHeight));

  useInput(
    (input, key) => {
      if (key.eventType === 'release') return;
      if (key.escape) {
        respond({ decision: 'decline' });
        return;
      }
      const current = Math.min(
        scrollRef.current,
        Math.max(0, lines.length - bodyHeight),
      );
      if (key.pageUp) setScroll(Math.max(0, current - bodyHeight));
      if (key.pageDown)
        setScroll(Math.min(lines.length - 1, current + bodyHeight));
      const count = (
        request.questions?.[questionIndexRef.current]?.options ??
        approvalOptions
      ).length;
      if (key.upArrow) setSelection(Math.max(0, selectionRef.current - 1));
      if (key.downArrow)
        setSelection(Math.min(count - 1, selectionRef.current + 1));
      if (request.kind === 'approval') {
        if (input === 'y') respond({ decision: 'accept' });
        if (input === 'n') respond({ decision: 'decline' });
        if (key.return)
          respond({
            decision: (['accept', 'decline', 'cancel'] as const)[
              selectionRef.current
            ]!,
          });
      }
    },
    { isActive: ready },
  );

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
    try {
      const content =
        request.url && !request.schema
          ? undefined
          : z
              .record(z.string(), z.unknown())
              .parse(JSON.parse(text.trim() || '{}'));
      if (request.schema) {
        const validator = new Ajv2020({ strict: false, formats: fullFormats });
        if (!validator.validate(request.schema, content)) {
          setError(validator.errorsText());
          return false;
        }
      }
      respond({ decision: 'accept', content });
      return true;
    } catch {
      setError('Enter a JSON object matching the requested fields.');
      return false;
    }
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
      <Box height={bodyHeight} overflow="hidden">
        <Text>{lines.slice(top, top + bodyHeight).join('\n')}</Text>
      </Box>
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
            ↑/↓ choose · Enter confirm · y allow · n decline · Esc decline ·
            Ctrl+C stop turn
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
                ? 'Cmd+click the URL, then press Enter when finished.'
                : 'Enter a JSON object with the requested fields.'}
          </Text>
          <Input
            key={questionIndex}
            width={width - 2}
            height={3}
            active={ready}
            secret={question?.secret}
            multiline={!question}
            placeholder={question ? 'Your answer' : '{}'}
            onSubmit={submit}
          />
          <Text dimColor>Esc decline · Ctrl+C stop turn</Text>
        </Box>
      )}
      {error && <Text color="red">{error}</Text>}
    </Box>
  );
}
