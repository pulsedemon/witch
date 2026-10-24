#!/usr/bin/env python3
"""check scratch retention and reclamation through private CLIs and real workers."""

import argparse
from contextlib import closing
import errno
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import shlex
import shutil
import signal
import struct
import subprocess
import tempfile
import termios
import time


def read_json(file):
    try:
        return json.loads(file.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def identity(pid):
    result = subprocess.run(
        ['/bin/ps', '-p', str(pid), '-o', 'lstart='],
        env={**os.environ, 'LC_ALL': 'C', 'TZ': 'UTC'},
        capture_output=True, text=True, timeout=5,
    )
    if result.returncode == 1:
        return None
    result.check_returncode()
    return {'pid': pid, 'started': result.stdout.strip()}


def wait_for(label, check, seconds=20):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        value = check()
        if value:
            return value
        time.sleep(0.05)
    raise AssertionError('timed out: ' + label)


class Cli:
    def __init__(self, root, command, env, name):
        self.root = root
        self.output = bytearray()
        self.status = None
        self.capture = root / (name + '.bin')
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            try:
                os.chdir(root / 'project')
                fcntl.ioctl(1, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
                os.execve(command[0], command + ['--state-dir', str(root / 'state'), '/new claude'], env)
            except Exception as error:
                os.write(2, str(error).encode())
                os._exit(127)

    def pump(self):
        if select.select([self.fd], [], [], 0.05)[0]:
            try:
                self.output.extend(os.read(self.fd, 65536))
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
        if self.status is None:
            done, status = os.waitpid(self.pid, os.WNOHANG)
            if done:
                self.status = os.waitstatus_to_exitcode(status)

    def wait(self, label, check, seconds=20):
        # drain continuously; sleeping between reads can block the CLI on a full PTY.
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            self.pump()
            value = check()
            if value:
                return value
            assert self.status is None, f'CLI exited {self.status} before {label}'
        raise AssertionError('timed out: ' + label)

    def presence(self):
        for file in (self.root / 'state/coordination/sessions').glob('*.json'):
            value = read_json(file)
            if value and value.get('agent') == 'claude' and value.get('process', {}).get('pid') == self.pid:
                return value
        return {}

    def ready(self, previous_activation=None, previous_init=None):
        initialized = self.root / 'project/initialize.json'
        def idle():
            value = self.presence()
            if (value.get('activation') != previous_activation
                    and value.get('phase') == 'idle'
                    and initialized.exists()
                    and initialized.stat().st_mtime_ns != previous_init):
                return value
            return False
        return self.wait('Claude ready', idle)

    def send(self, text):
        os.write(self.fd, text.encode())
        for _ in range(4):
            self.pump()
        os.write(self.fd, b'\x1b[13u')

    def shell(self, words):
        before = self.presence()['updatedAt']
        content = self.root / 'project/content.json'
        previous = content.stat().st_mtime_ns if content.exists() else None
        self.send('!' + shlex.join(words))
        self.wait('fixture command receipt', lambda: content.exists() and content.stat().st_mtime_ns != previous)
        self.wait('command settled', lambda: self.presence().get('phase') == 'idle'
                  and self.presence().get('updatedAt', 0) > before)

    def jobs_empty(self):
        cut = len(self.output)
        self.send('/jobs')
        self.wait('empty jobs view', lambda: b'No jobs are running' in self.output[cut:])
        cut = len(self.output)
        os.write(self.fd, b'\x1b[27u')
        self.wait('composer after jobs', lambda: b'the agent, or type /help' in self.output[cut:])

    def quit(self):
        self.send('/exit')
        self.wait('CLI exit', lambda: self.status is not None)
        assert self.status == 0, f'CLI exit {self.status}'

    def close(self):
        try:
            if self.status is None:
                os.kill(self.pid, signal.SIGTERM)
                deadline = time.monotonic() + 8
                while self.status is None and time.monotonic() < deadline:
                    self.pump()
                if self.status is None:
                    os.kill(self.pid, signal.SIGKILL)
                    _, status = os.waitpid(self.pid, 0)
                    self.status = os.waitstatus_to_exitcode(status)
        finally:
            self.capture.write_bytes(self.output)
            os.close(self.fd)


def run_case(root, socket, name, restarts, kind, command, env, node, tmux):
    root.mkdir()
    (root / 'project').mkdir()
    expected = 'scratch-' + name
    reporter = root / 'report.mjs'
    reporter.write_text("""import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [file, marker] = process.argv.slice(2);
if (marker) writeFileSync(join(process.env.TMPDIR, 'marker'), marker);
writeFileSync(file, JSON.stringify({ tmpdir: process.env.TMPDIR, mark: process.env.WITCH_JOBS }));
""")
    worker = root / 'worker.mjs'
    worker.write_text("""import { spawn } from 'node:child_process';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const [root, kind] = process.argv.slice(2);
const stage = kind === 'second' ? 'descendant' : 'worker';
writeFileSync(join(root, stage + '.ready.json'), JSON.stringify({ pid: process.pid, tmpdir: process.env.TMPDIR, mark: process.env.WITCH_JOBS }));
const deadline = setTimeout(() => process.exit(2), 120000);
const timer = setInterval(() => {
  if (!existsSync(join(root, 'release-' + stage))) return;
  clearInterval(timer);
  clearTimeout(deadline);
  if (kind === 'descendant') {
    const child = spawn(process.execPath, [process.argv[1], root, 'second'], { detached: true, stdio: 'ignore' });
    writeFileSync(join(root, 'descendant.pid'), String(child.pid));
    child.unref();
  }
  let result;
  try { result = { text: readFileSync(join(process.env.TMPDIR, 'marker'), 'utf8') }; }
  catch (error) { result = { code: error.code }; }
  writeFileSync(join(root, stage + '.result.json'), JSON.stringify(result));
}, 20);
""")
    finish = root / 'finish.mjs'
    finish.write_text("""import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
let result;
try { result = { text: readFileSync(join(process.env.TMPDIR, 'marker'), 'utf8') }; }
catch (error) { result = { code: error.code }; }
writeFileSync(join(process.argv[2], 'worker.result.json'), JSON.stringify(result));
""")
    shell = root / 'worker.zsh'
    shell.write_text(r"""trap '' HUP
printf '%s' "$$" > "$1/worker.pid"
if [[ "$2" = older ]]; then
  while [[ ! -f "$1/scratch-location" ]]; do
    [[ -f "$1/release-worker" ]] && exit 0
    /bin/sleep 0.05
  done
  export TMPDIR=$(<"$1/scratch-location")
fi
printf '{"pid":%s}\n' "$$" > "$1/worker.ready.json"
while [[ ! -f "$1/release-worker" ]]; do /bin/sleep 0.05; done
exec """ + shlex.join([node, str(finish), str(root)]) + '\n')
    launcher = root / 'launch.mjs'
    launcher.write_text("""import { spawn } from 'node:child_process';
const child = spawn(process.argv[2], process.argv.slice(3), { detached: true, stdio: 'ignore' });
child.unref();
""")
    report = {'case': name, 'entry': command[-1], 'artifacts': str(root)}
    report['controller_identity'] = identity(os.getpid())
    workers = []
    monitor = None
    try:
        if kind == 'older-tmux':
            subprocess.run([tmux, '-f', '/dev/null', '-S', str(socket), 'new-session', '-d',
                            'exec ' + shlex.join(['/bin/zsh', str(shell), str(root), 'older'])],
                           check=True, capture_output=True, timeout=5)
            worker_pid = wait_for('older pane', lambda: (root / 'worker.pid').read_text()
                                  if (root / 'worker.pid').exists() else None)
            worker_identity = identity(int(worker_pid))
            assert worker_identity
            workers.append(worker_identity)
            report['worker_identity'] = worker_identity
        # native start identities have second precision; keep the controller's ancestry unambiguous.
        second = int(time.time())
        wait_for('distinct controller start', lambda: int(time.time()) > second)
        with closing(Cli(root, command, env, 'terminal')) as cli:
            presence = cli.ready()
            report['cli_identity'] = presence['process']
            assert presence['process'] == identity(cli.pid)
            assert presence['process']['started'] != report['controller_identity']['started']
            scratch_report = root / 'scratch.json'
            cli.shell([node, str(reporter), str(scratch_report), expected])
            scratch = read_json(scratch_report)
            assert scratch and scratch['mark']
            directory = Path(scratch['tmpdir'])
            assert directory.parent == root / 'state/scratch'
            report['scratch'] = str(directory)
            metadata = read_json(directory / '.witch-scratch.json')
            assert metadata['version'] == 2
            report['requires_boot'] = metadata['requiresBoot']
            assert metadata['requiresBoot'] == (kind == 'older-tmux'), 'unexpected initial ownership uncertainty'
            if kind == 'tmux':
                cli.shell([tmux, '-f', '/dev/null', '-S', str(socket), 'new-session', '-d', '-s', 'worker',
                           'exec ' + shlex.join([node, str(worker), str(root), kind])])
            elif kind == 'older-tmux':
                (root / 'scratch-location').write_text(str(directory))
            elif kind != 'none':
                words = ['/bin/zsh', str(shell), str(root), 'new'] if kind == 'shell' else [node, str(worker), str(root), kind]
                cli.shell([node, str(launcher), *words])
            if kind != 'none':
                info = cli.wait('worker ready', lambda: read_json(root / 'worker.ready.json'))
                if kind in ('tmux', 'node', 'descendant'):
                    assert info['tmpdir'] == scratch['tmpdir'] and info['mark'] == scratch['mark']
                worker_identity = identity(info['pid'])
                assert worker_identity
                if worker_identity not in workers:
                    workers.append(worker_identity)
                report['worker_identity'] = worker_identity
                if kind == 'older-tmux':
                    subprocess.run([tmux, '-S', str(socket), 'kill-server'], check=True, capture_output=True, timeout=5)
                    assert identity(worker_identity['pid']) == worker_identity
            report['activations'] = [presence['activation']]
            for index in range(restarts):
                initialized = (root / 'project/initialize.json').stat().st_mtime_ns
                cli.send('/restart')
                presence = cli.ready(report['activations'][-1], initialized)
                report['activations'].append(presence['activation'])
                assert presence['process'] == report['cli_identity'] == identity(cli.pid)
                assert identity(worker_identity['pid']) == worker_identity
                resumed = root / f'restart-{index}.json'
                cli.shell([node, str(reporter), str(resumed)])
                assert read_json(resumed)['tmpdir'] == str(directory)
                assert read_json(directory / '.witch-scratch.json')['requiresBoot'] == metadata['requiresBoot']
            if kind in ('none', 'tmux'):
                cli.jobs_empty()
                report['jobs_empty'] = True
            if name == 'periodic':
                monitor = Cli(root, command, env, 'monitor')
                monitor.ready()
            cli.quit()
            report['cli_exit'] = cli.status
            assert directory.is_dir(), report
            if kind != 'none':
                assert identity(worker_identity['pid']) == worker_identity
                with closing(Cli(root, command, env, 'reader-sweep')) as reader_sweep:
                    reader_sweep.ready()
                    assert (directory / 'marker').read_text() == expected
                    reader_sweep.quit()
                (root / 'release-worker').write_text('release')
                report['worker_result'] = wait_for('worker read', lambda: read_json(root / 'worker.result.json'))
                assert report['worker_result'] == {'text': expected}, report
                wait_for('worker exit', lambda: identity(worker_identity['pid']) != worker_identity)
                if kind == 'descendant':
                    info = wait_for('descendant ready', lambda: read_json(root / 'descendant.ready.json'))
                    descendant = identity(info['pid'])
                    assert descendant
                    workers.append(descendant)
                    with closing(Cli(root, command, env, 'descendant-sweep')) as descendant_sweep:
                        descendant_sweep.ready()
                        assert (directory / 'marker').read_text() == expected
                        descendant_sweep.quit()
                    (root / 'release-descendant').write_text('release')
                    report['descendant_result'] = wait_for('descendant read', lambda: read_json(root / 'descendant.result.json'))
                    assert report['descendant_result'] == {'text': expected}
                    wait_for('descendant exit', lambda: identity(descendant['pid']) != descendant)
                if kind == 'tmux':
                    wait_for('tmux exit', lambda: subprocess.run([tmux, '-S', str(socket), 'list-sessions'],
                                                               capture_output=True, timeout=5).returncode != 0)
            if monitor:
                monitor.wait('periodic reclamation', lambda: not directory.exists(), seconds=80)
                report['periodic_reclamation'] = True
                monitor.quit()
            else:
                with closing(Cli(root, command, env, 'next-launch')) as cleaner:
                    cleaner.ready()
                    if kind == 'older-tmux':
                        assert (directory / 'marker').read_text() == expected
                        report['uncertain_retained'] = True
                    else:
                        assert not directory.exists(), report
                        report['same_boot_reclaimed'] = True
                    cleaner.quit()
    finally:
        (root / 'release-worker').write_text('release')
        (root / 'release-descendant').write_text('release')
        if monitor:
            monitor.close()
        subprocess.run([tmux, '-S', str(socket), 'kill-server'], capture_output=True, timeout=5)
        info = read_json(root / 'worker.ready.json')
        if info and not any(record['pid'] == info['pid'] for record in workers):
            current = identity(info['pid'])
            if current:
                workers.append(current)
        for recorded in workers:
            wait_for('worker cleanup', lambda recorded=recorded: identity(recorded['pid']) != recorded, seconds=8)
        # read the child PID after its parent exits; the ready file can appear later.
        descendant_pid = read_json(root / 'descendant.pid')
        if descendant_pid:
            descendant = identity(descendant_pid)
            if descendant:
                wait_for('descendant cleanup', lambda: identity(descendant_pid) != descendant, seconds=8)
        (root / 'result.json').write_text(json.dumps(report, indent=2) + '\n')
        server = subprocess.run([tmux, '-S', str(socket), 'list-sessions'], capture_output=True, timeout=5)
        assert server.returncode != 0, 'private tmux server survived'
    return report


def main():
    cases = [('fresh-quit', 0, 'none'), ('tmux-quit', 0, 'tmux'),
             ('tmux-one-restart', 1, 'tmux'), ('tmux-two-restarts', 2, 'tmux'),
             ('opaque-shell', 0, 'shell'), ('later-descendant', 0, 'descendant'),
             ('periodic', 0, 'node'), ('uncertain-old-pane', 1, 'older-tmux')]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('cli', type=Path, help='source cli.tsx or built cli.js')
    parser.add_argument('--case', dest='selected', action='append',
                        choices=[name for name, _, _ in cases], help='run only this case; repeat to select several')
    args = parser.parse_args()
    entry = args.cli.resolve(strict=True)
    repo = Path(__file__).resolve().parent.parent
    node = shutil.which('node')
    tmux = shutil.which('tmux')
    assert node and tmux, 'node and tmux must be on PATH'
    command = [node]
    if entry.suffix == '.tsx':
        command += ['--import', str(repo / 'scripts/register.mjs')]
    command.append(str(entry))
    root = Path(tempfile.mkdtemp(prefix='scratch-check-', dir=os.environ['TMPDIR'])).resolve()
    print('Artifacts: ' + str(root), flush=True)
    bin_dir = root / 'bin'
    bin_dir.mkdir()
    for name in ('claude', 'codex'):
        shim = bin_dir / name
        shim.write_text('#!/bin/sh\nexec ' + shlex.join([node, str(repo / 'test/fixtures' / (name + '.mjs'))]) + ' "$@"\n')
        shim.chmod(0o755)
    env = dict(os.environ)
    for name in ('WITCH_CONVERSATION', 'WITCH_SCRATCH', 'WITCH_JOBS', 'TMUX', 'NODE_TEST_CONTEXT'):
        env.pop(name, None)
    env.update(PATH=str(bin_dir) + os.pathsep + env['PATH'],
               TSX_TSCONFIG_PATH=str(repo / 'tsconfig.json'), TERM='xterm-256color')
    failed = False
    for index, (name, restarts, kind) in enumerate(cases):
        if args.selected and name not in args.selected:
            continue
        socket = root / f'w{index}'
        assert len(os.fsencode(socket)) < 104, 'TMPDIR is too long for a macOS tmux socket'
        try:
            report = run_case(root / name, socket, name, restarts, kind, command, env, node, tmux)
            print('PASS ' + json.dumps(report), flush=True)
        except Exception as error:
            failed = True
            print(f'FAIL {name}: {error}', flush=True)
    return int(failed)


if __name__ == '__main__':
    raise SystemExit(main())
