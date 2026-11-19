import type { PreviewStatus } from '../core/preview.js';

/** the title needs a row as well as the frame; input and readable body rows keep priority. */
export function previewLayout(
  height: number,
  minimum: number,
  preview?: PreviewStatus,
) {
  const available = Math.max(0, height - minimum);

  const rows =
    preview && available >= 2 ? Math.min(available, preview.rows + 1) : 0;

  return { preview: rows, body: Math.max(0, height - rows) };
}
