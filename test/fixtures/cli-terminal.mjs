import process from 'node:process';
import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const restartGate = process.env.WITCH_TEST_RESTART_GATE;
if (restartGate && process.env.WITCH_JOBS_RESUME === '1') {
  writeFileSync(restartGate, '');
  while (!existsSync(`${restartGate}.release`)) await delay(20);
}

Object.defineProperty(process.stdin, 'isTTY', { value: true });
process.stdin.setRawMode = () => process.stdin;
Object.defineProperties(process.stdout, {
  isTTY: { value: true },
  columns: { value: 100 },
  rows: { value: 35 },
});
