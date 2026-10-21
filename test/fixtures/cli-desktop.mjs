import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import process from 'node:process';
import { promisify } from 'node:util';
import { setImmediate } from 'node:timers';

Object.defineProperty(process.stdin, 'isTTY', { value: true });
process.stdin.setRawMode = () => process.stdin;
Object.defineProperties(process.stdout, {
  isTTY: { value: true },
  columns: { value: 80 },
  rows: { value: 30 },
});

let failure;
process.on('message', (message) => {
  failure = message.failure;
  process.send({ configured: failure });
});
process.channel.unref();

const execute = childProcess.execFile;
childProcess.execFile = (file, ...args) => {
  if (file !== '/usr/bin/open' && file !== '/usr/bin/pbcopy')
    return execute(file, ...args);
  const callback = args.at(-1);
  const fail = failure === file;
  const child = execute(
    process.execPath,
    [
      '-e',
      file === '/usr/bin/open'
        ? `process.exit(${fail ? 7 : 0})`
        : `process.stdin.setEncoding('utf8'); let text = ''; process.stdin.on('data', chunk => text += chunk); process.stdin.on('end', () => { process.stdout.write(text); process.exitCode = ${fail ? 7 : 0}; });`,
    ],
    (error, stdout, stderr) => {
      process.send({
        file,
        args: file === '/usr/bin/open' ? args[0] : [],
        text: stdout,
        failed: Boolean(error),
      });
      callback(error && new Error(`fixture ${file} failed`), stdout, stderr);
    },
  );
  if (fail && file === '/usr/bin/pbcopy')
    setImmediate(() =>
      child.stdin.emit(
        'error',
        Object.assign(new Error('fixture pipe closed'), { code: 'EPIPE' }),
      ),
    );
  return child;
};
Object.defineProperty(childProcess.execFile, promisify.custom, {
  value: execute[promisify.custom],
});
syncBuiltinESMExports();
