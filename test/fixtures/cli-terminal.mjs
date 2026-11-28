import process from 'node:process';
import { existsSync, writeFileSync } from 'node:fs';
import { setImmediate } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';

const restartGate = process.env.WITCH_TEST_RESTART_GATE;
const resuming = restartGate && process.env.WITCH_JOBS_RESUME === '1';

if (resuming) {
  writeFileSync(restartGate, '');

  while (!existsSync(`${restartGate}.release`)) await delay(20);
}

Object.defineProperty(process.stdin, 'isTTY', { value: true });

process.stdin.setRawMode = (enabled) => {
  if (resuming && enabled)
    // Ink attaches its input listeners in the effect that sets raw mode.
    setImmediate(() => writeFileSync(`${restartGate}.input-ready`, ''));

  return process.stdin;
};

Object.defineProperties(process.stdout, {
  isTTY: { value: true },
  columns: { value: 100 },
  rows: { value: 35 },
});
