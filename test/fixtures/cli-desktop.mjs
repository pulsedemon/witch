import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import process from 'node:process';
import { promisify } from 'node:util';
import { setImmediate } from 'node:timers';
import { subscribe } from 'node:diagnostics_channel';
import { performance } from 'node:perf_hooks';
import { pathToFileURL, URL } from 'node:url';

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

const { Coordinator } = await import(
  new URL('./core/coordinator.js', pathToFileURL(process.argv[1]))
);
const memoryDirectories = Coordinator.prototype.memoryDirectories;
Coordinator.prototype.memoryDirectories = function () {
  if (failure === 'memoryDirectories')
    return Promise.reject(new Error('fixture memory lookup failed'));
  return memoryDirectories.call(this);
};

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

const started = performance.now();
const diagnostic = (event) =>
  process.send({
    diagnostic: JSON.stringify({ at: performance.now() - started, ...event }),
  });
diagnostic({ event: 'preload', pid: process.pid });
subscribe('child_process', ({ process: child }) => {
  const started = performance.now();
  child.once('spawn', () =>
    diagnostic({ event: 'spawn', pid: child.pid, args: child.spawnargs }),
  );
  child.once('error', (error) =>
    diagnostic({ event: 'error', pid: child.pid, message: error.message }),
  );
  child.once('close', (code, signal) =>
    diagnostic({
      event: 'close',
      pid: child.pid,
      args: child.spawnargs,
      elapsed: performance.now() - started,
      code,
      signal,
    }),
  );
});
