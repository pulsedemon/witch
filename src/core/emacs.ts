// Emacs keeps these operands with their options when it sorts startup arguments.
const operandOptions = [
  '-chdir',
  '--chdir',
  '-t',
  '--terminal',
  '-script',
  '--script',
  '-d',
  '--display',
  '-display',
  '-init-directory',
  '--init-directory',
  '-u',
  '--user',
  '-user',
  '-bg',
  '--background-color',
  '-background',
  '-fg',
  '--foreground-color',
  '-foreground',
  '-bd',
  '--border-color',
  '-bw',
  '--border-width',
  '-ib',
  '--internal-border',
  '-ms',
  '--mouse-color',
  '-cr',
  '--cursor-color',
  '-fn',
  '--font',
  '-font',
  '-g',
  '--geometry',
  '-geometry',
  '-T',
  '--title',
  '-title',
  '-name',
  '--name',
  '-xrm',
  '--xrm',
  '-parent-id',
  '--parent-id',
  '-temacs',
  '--temacs',
  '-dump-file',
  '--dump-file',
  '-seccomp',
  '--seccomp',
  '-NSAutoLaunch',
  '-NXAutoLaunch',
  '-_NSMachLaunch',
  '-MachLaunch',
  '-NSHost',
  '-L',
  '--directory',
  '-directory',
  '-l',
  '--load',
  '-load',
  '-scriptload',
  '-f',
  '--funcall',
  '-funcall',
  '-eval',
  '--eval',
  '-execute',
  '--execute',
  '-find-file',
  '--find-file',
  '-visit',
  '--visit',
  '-file',
  '--file',
  '-insert',
  '--insert',
  '-NXOpen',
  '-NXOpenTemp',
  '-NSOpen',
  '-NSOpenTemp',
  '-GSFilePath',
];

const flagOptions = [
  '--version',
  '--fingerprint',
  '--no-window-system',
  '--no-windows',
  '--batch',
  '--daemon',
  '--bg-daemon',
  '--fg-daemon',
  '--help',
  '--no-loadup',
  '--no-site-lisp',
  '--no-build-details',
  '--module-assertions',
  '--quick',
  '--no-init-file',
  '--no-x-resources',
  '--no-site-file',
  '--no-comp-spawn',
  '--debug-init',
  '--iconic',
  '--basic-display',
  '--no-blinking-cursor',
  '--no-bitmap-icon',
  '--fullscreen',
  '--fullwidth',
  '--fullheight',
  '--maximized',
  '--reverse-video',
  '--horizontal-scroll-bars',
  '--vertical-scroll-bars',
  '--color',
  '--no-splash',
  '--no-desktop',
  '--kill',
];

function matchesOption(option: string, name: string, minimum: number): boolean {
  return (
    option === `-${name}` ||
    (option.startsWith('--') &&
      option.length >= minimum &&
      `--${name}`.startsWith(option))
  );
}

/** option operands and Lisp payloads cannot select daemon or batch mode. */
export function isEmacsDaemon(argv: readonly string[]): boolean {
  let daemon = false;
  for (let at = 1; at < argv.length; at++) {
    const argument = argv[at]!;
    if (argument === '--') break;
    const option = argument.startsWith('--')
      ? argument.split('=', 1)[0]!
      : argument;
    if (
      option === '-x' ||
      matchesOption(option, 'batch', 5) ||
      matchesOption(option, 'script', 3)
    )
      return false;
    if (
      matchesOption(option, 'daemon', 5) ||
      matchesOption(option, 'bg-daemon', 10) ||
      matchesOption(option, 'fg-daemon', 10)
    )
      daemon = true;
    const matches = option.startsWith('--')
      ? [...operandOptions, ...flagOptions].filter((candidate) =>
          candidate.startsWith(option),
        )
      : [];
    if (
      !argument.includes('=') &&
      (operandOptions.includes(option) ||
        (matches.length === 1 && operandOptions.includes(matches[0]!)))
    )
      at++;
  }
  return daemon;
}
