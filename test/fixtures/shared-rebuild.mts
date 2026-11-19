import { refreshInstall } from '../../src/core/repository/install-refresh.js';

const [install, mode] = process.argv.slice(2) as [string, string];
const abort = new AbortController();
const reason = new Error('rebuild cancelled');
const release = Promise.withResolvers<void>();
const calls: string[][] = [];

process.on('message', (message) => {
  if (message === 'cancel') abort.abort(reason);
  else if (message === 'finish') release.resolve();
});

try {
  const text = await refreshInstall(
    install,
    'main',
    async (_, args) => {
      calls.push(args);

      if (args[0] === 'build') {
        process.send!({ kind: 'build' });

        await new Promise<void>((resolve, reject) => {
          const stop = () => reject(abort.signal.reason);
          abort.signal.addEventListener('abort', stop, { once: true });

          void release.promise.then(() => {
            abort.signal.removeEventListener('abort', stop);
            resolve();
          });
        });

        if (mode === 'fail')
          throw Object.assign(new Error('build failed'), {
            stdout: 'src/probe.ts: build diagnostic\n',
          });
      }

      return { stdout: '' };
    },
    {
      signal: abort.signal,
      notice: (text) => process.send!({ kind: 'waiting', text }),
    },
  );

  process.send!({ kind: 'result', text, calls });
} catch (error) {
  process.send!({
    kind: 'result',
    error: (error as Error).message,
    originalReason: error === reason,
    calls,
  });
} finally {
  process.disconnect();
}
