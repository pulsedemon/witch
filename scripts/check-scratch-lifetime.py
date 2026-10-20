#!/usr/bin/env python3
"""check scratch lifetime through a private CLI, fixture agents and real tmux workers."""

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

    def wait(self, label, check):
        # drain continuously; sleeping between reads can block the CLI on a full PTY.
        deadline = time.monotonic() + 20
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


def run_case(root, socket, name, restarts, command, env, node, tmux):
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
    worker.write_text("""import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const root = process.argv[2];
writeFileSync(join(root, 'worker.ready.json'), JSON.stringify({ pid: process.pid, tmpdir: process.env.TMPDIR, mark: process.env.WITCH_JOBS }));
const deadline = setTimeout(() => process.exit(2), 120000);
const timer = setInterval(() => {
  if (!existsSync(join(root, 'release'))) return;
  clearInterval(timer);
  clearTimeout(deadline);
  let result;
  try { result = { text: readFileSync(join(process.env.TMPDIR, 'marker'), 'utf8') }; }
  catch (error) { result = { code: error.code }; }
  writeFileSync(join(root, 'worker.result.json'), JSON.stringify(result));
}, 20);
""")
    report = {'case': name, 'entry': command[-1], 'artifacts': str(root)}
    worker_identity = None
    try:
        with closing(Cli(root, command, env, 'terminal')) as cli:
            presence = cli.ready()
            report['cli_identity'] = presence['process']
            assert presence['process'] == identity(cli.pid)
            scratch_report = root / 'scratch.json'
            cli.shell([node, str(reporter), str(scratch_report), expected])
            scratch = read_json(scratch_report)
            assert scratch and scratch['mark']
            directory = Path(scratch['tmpdir'])
            assert directory.parent == root / 'state/scratch'
            report['scratch'] = str(directory)
            if restarts is not None:
                cli.shell([tmux, '-f', '/dev/null', '-S', str(socket), 'new-session', '-d', '-s', 'worker',
                           'exec ' + shlex.join([node, str(worker), str(root)])])
                info = cli.wait('worker ready', lambda: read_json(root / 'worker.ready.json'))
                assert info['tmpdir'] == scratch['tmpdir'] and info['mark'] == scratch['mark']
                worker_identity = identity(info['pid'])
                assert worker_identity
                report['worker_identity'] = worker_identity
            report['activations'] = [presence['activation']]
            for index in range(restarts or 0):
                initialized = (root / 'project/initialize.json').stat().st_mtime_ns
                cli.send('/restart')
                presence = cli.ready(report['activations'][-1], initialized)
                report['activations'].append(presence['activation'])
                assert presence['process'] == report['cli_identity'] == identity(cli.pid)
                assert identity(worker_identity['pid']) == worker_identity
                resumed = root / f'restart-{index}.json'
                cli.shell([node, str(reporter), str(resumed)])
                assert read_json(resumed)['tmpdir'] == str(directory)
            cli.jobs_empty()
            report['jobs_empty'] = True
            cli.quit()
            report['cli_exit'] = cli.status
            report['scratch_exists_after_quit'] = directory.is_dir()
            if worker_identity:
                report['worker_alive_after_quit'] = identity(worker_identity['pid']) == worker_identity
                assert report['worker_alive_after_quit']
                (root / 'release').write_text('release')
                report['worker_result'] = wait_for('worker read', lambda: read_json(root / 'worker.result.json'))
                wait_for('worker exit', lambda: identity(worker_identity['pid']) != worker_identity)
            assert directory.is_dir(), report
            assert (directory / 'marker').read_text() == expected
            if worker_identity:
                assert report['worker_result'] == {'text': expected}, report
        if restarts is None:
            initialized = (root / 'project/initialize.json').stat().st_mtime_ns
            with closing(Cli(root, command, env, 'next-launch')) as cli:
                cli.ready(previous_init=initialized)
                cli.quit()
            assert (directory / 'marker').read_text() == expected
            report['same_boot_launch_retained_marker'] = True
    finally:
        (root / 'release').write_text('release')
        info = read_json(root / 'worker.ready.json')
        try:
            if info:
                wait_for('worker cleanup', lambda: identity(info['pid']) is None, seconds=8)
        finally:
            subprocess.run([tmux, '-S', str(socket), 'kill-server'], capture_output=True, timeout=5)
            (root / 'result.json').write_text(json.dumps(report, indent=2) + '\n')
        server = subprocess.run([tmux, '-S', str(socket), 'list-sessions'], capture_output=True, timeout=5)
        assert server.returncode != 0, 'private tmux server survived'
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('cli', type=Path, help='source cli.tsx or built cli.js')
    args = parser.parse_args()
    entry = args.cli.resolve(strict=True)
    repo = Path(__file__).resolve().parent.parent
    node = shutil.which('node')
    tmux = shutil.which('tmux')
    assert node and tmux, 'node and tmux must be on PATH'
    command = [node]
    if entry.suffix == '.tsx':
        loader = subprocess.check_output([node, '--input-type=module', '-e', "console.log(import.meta.resolve('tsx'))"],
                                         cwd=repo, text=True, timeout=5).strip()
        command += ['--import', loader]
    command.append(str(entry))
    root = Path(tempfile.mkdtemp(prefix='s102-', dir=os.environ['TMPDIR'])).resolve()
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
    for index, (name, restarts) in enumerate((('fresh-quit', None), ('tmux-quit', 0),
                                             ('tmux-one-restart', 1), ('tmux-two-restarts', 2))):
        socket = root / f'w{index}'
        assert len(os.fsencode(socket)) < 104, 'TMPDIR is too long for a macOS tmux socket'
        try:
            report = run_case(root / name, socket, name, restarts, command, env, node, tmux)
            print('PASS ' + json.dumps(report), flush=True)
        except Exception as error:
            failed = True
            print(f'FAIL {name}: {error}', flush=True)
    return int(failed)


if __name__ == '__main__':
    raise SystemExit(main())
