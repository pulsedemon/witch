import { fileURLToPath } from 'node:url';

const marked = '\u001b]8;copy=target;';
/** the OSC 8 code opening a link that copies its destination after its text. */
export const copiedLink = (url: string) => `${marked}${url}\u0007`;

/** the file a `vscode://file` or `file://` URL names, with its `:line:column` apart. throws when the path cannot be decoded. */
export function linkedFile(
  url: string,
): { path: string; location: string } | undefined {
  const file = /^vscode:\/\/file(\/.*?)((?::\d+){0,2})$/.exec(url);

  if (file) return { path: decodeURIComponent(file[1]!), location: file[2]! };

  return url.startsWith('file://')
    ? { path: fileURLToPath(url), location: '' }
    : undefined;
}

/** what a link to `url` copies after its text: a web address as written, or a file's path and location. none when the path cannot be decoded. */
export function destination(url: string): string | undefined {
  if (/^https?:\/\//i.test(url)) return url;

  try {
    const file = linkedFile(url);

    return file && file.path + file.location;
  } catch {
    return undefined;
  }
}

/** the destination an OSC 8 `code` copies, when it opens a link written by `copiedLink`. */
export const copiedDestination = (code: string | undefined) =>
  code?.startsWith(marked)
    ? destination(code.slice(marked.length, -1))
    : undefined;
