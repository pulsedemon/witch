import { Buffer } from 'node:buffer';
import process from 'node:process';
import readline from 'node:readline';
import { setInterval } from 'node:timers';

const pending = [];

if (process.argv.includes('--ignore-term')) {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
}

const lines = readline.createInterface({ input: process.stdin });

for await (const line of lines) {
  const message = JSON.parse(line);

  if (message.method === 'hold') continue;

  if (message.method === 'write') {
    process.stdout.write(Buffer.from(message.params.bytes));
  } else if (message.method === 'end') {
    process.stdout.end();
  } else if (message.method === 'reverse') {
    pending.push(message);

    if (pending.length === 2) {
      for (const request of pending.reverse()) {
        process.stdout.write(
          JSON.stringify({ id: request.id, result: request.params }) + '\n',
        );
      }
    }
  } else if (message.method === 'approval') {
    process.stdout.write(
      JSON.stringify({
        id: 91,
        method: 'approve',
        params: { command: 'touch file' },
      }) + '\n',
    );
  } else if (message.id === 91) {
    process.stdout.write(
      JSON.stringify({ method: 'approved', params: message.result }) + '\n',
    );
  } else if (message.method === 'garbage') {
    process.stdout.write('not json\n');
  } else if (message.method === 'exit') {
    process.stderr.write('Native configuration is invalid', () =>
      process.exit(7),
    );
  }
}
