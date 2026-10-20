/** `text` in single quotes, for zsh and bash. */
export function quote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}
