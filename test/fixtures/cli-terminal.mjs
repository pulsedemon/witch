import process from 'node:process';

Object.defineProperty(process.stdin, 'isTTY', { value: true });
process.stdin.setRawMode = () => process.stdin;
Object.defineProperties(process.stdout, {
  isTTY: { value: true },
  columns: { value: 100 },
  rows: { value: 35 },
});
