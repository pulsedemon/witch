import { readFileSync } from 'node:fs';

export function peerAnswer(input) {
  const [, encoded] = /Read their messages from ("[^\n]+")./.exec(input);

  const requests = JSON.parse(readFileSync(JSON.parse(encoded), 'utf8'));

  return JSON.stringify({
    answers: requests.map(({ id, message }) => ({
      id,
      message: `Read: ${message}`,
    })),
  });
}
