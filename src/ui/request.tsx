import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import wrapAnsi from 'wrap-ansi';
import { z } from 'zod';
import type { UserRequest, UserResponse } from '../agents/types.js';
import { Input } from './input.js';
import { linkify } from './links.js';

interface Props {
  request: UserRequest;
  width: number;
  height: number;
  cwd: string;
  respond(response: UserResponse): void;
}

export function Request({ request, width, height, cwd, respond }: Props) {
  const [selection, setSelection] = useState(0);
  const [questionIndex, setQuestionIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [scroll, setScroll] = useState(0);
  const [error, setError] = useState('');
  const question = request.questions?.[questionIndex];
  const options = question?.options ?? ['Allow once', 'Decline', 'Cancel turn'];
  const bodyHeight = Math.max(2, height - 7);
  const detail = question
    ? `${question.title}\n\n${options.map((option, index) => `${index === selection ? '›' : ' '} ${index + 1}. ${option}`).join('\n')}`
    : `${request.title}\n\n${request.url ?? ''}\n${request.detail}${request.schema ? `\n\nRequested fields:\n${JSON.stringify(request.schema, null, 2)}` : ''}`;
  const lines = wrapAnsi(linkify(detail, cwd), width - 2, {
    hard: true,
    trim: false,
  }).split('\n');
  const top = Math.min(scroll, Math.max(0, lines.length - bodyHeight));

  useInput((input, key) => {
    if (key.eventType === 'release') return;
    if (key.escape) {
      respond({ decision: 'cancel' });
      return;
    }
    if (key.pageUp) setScroll(Math.max(0, top - bodyHeight));
    if (key.pageDown) setScroll(Math.min(lines.length - 1, top + bodyHeight));
    if (key.upArrow) setSelection(Math.max(0, selection - 1));
    if (key.downArrow)
      setSelection(Math.min(options.length - 1, selection + 1));
    if (!question && request.kind === 'approval') {
      if (input === 'y') respond({ decision: 'accept' });
      if (input === 'n') respond({ decision: 'decline' });
      if (key.return)
        respond({
          decision: (['accept', 'decline', 'cancel'] as const)[selection]!,
        });
    }
  });

  const submit = (text: string): boolean => {
    if (question) {
      const values = text.trim()
        ? (question.multiple ? text.split(',') : [text]).map((value) => {
            const number = Number(value.trim());
            return Number.isInteger(number) &&
              number > 0 &&
              number <= options.length
              ? options[number - 1]!
              : value.trim();
          })
        : options[selection]
          ? [options[selection]!]
          : [];
      if (!values.length) return false;
      const next = { ...answers, [question.id]: values };
      if (questionIndex + 1 === request.questions!.length)
        respond({ decision: 'accept', answers: next });
      else {
        setAnswers(next);
        setQuestionIndex(questionIndex + 1);
        setSelection(0);
        setScroll(0);
      }
      return true;
    }
    try {
      const content = text.trim()
        ? z.record(z.string(), z.unknown()).parse(JSON.parse(text))
        : undefined;
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
            ↑/↓ choose · Enter confirm · y allow · n decline · Esc cancel
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
            cwd={cwd}
            active
            secret={question?.secret}
            multiline={!question}
            placeholder={question ? 'Your answer' : '{}'}
            onSubmit={submit}
          />
        </Box>
      )}
      {error && <Text color="red">{error}</Text>}
    </Box>
  );
}
