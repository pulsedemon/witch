import { randomUUID } from 'node:crypto';
import stringWidth from 'string-width';
import { z } from 'zod';

export const previewBytes = 2 * 1024 * 1024;
const controls = /\p{Cc}/u;
const sgr = new Set(['', '0', '1', '2', '22', '39', '49']);
// eslint-disable-next-line no-control-regex
const formatting = /\u001b\[([0-9;]*)m/gu;

function plainRow(text: string): string | undefined {
  let valid = true;

  const plain = text.replace(formatting, (_, code: string) => {
    const parts = code.split(';');

    for (let index = 0; index < parts.length; index++) {
      if (sgr.has(parts[index]!)) continue;

      if (
        !['38', '48'].includes(parts[index]!) ||
        parts[index + 1] !== '2' ||
        index + 4 >= parts.length ||
        !parts
          .slice(index + 2, index + 5)
          .every(
            (channel) => /^\d{1,3}$/u.test(channel) && Number(channel) <= 255,
          )
      ) {
        valid = false;

        break;
      }

      index += 4;
    }

    return '';
  });

  return valid && !controls.test(plain) ? plain : undefined;
}

const row = z.string().refine((text) => {
  const plain = plainRow(text);

  // each UTF-16 code unit contributes at most two columns, so short rows need no grapheme scan.
  return (
    plain !== undefined &&
    (plain.length * 2 <= 512 || stringWidth(plain) <= 512)
  );
}, 'Preview rows allow text and restricted SGR formatting, up to 512 columns.');

export const previewDocumentSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(1)
      .refine(
        (text) => !controls.test(text) && stringWidth(text) <= 512,
        'Preview titles must be plain text, up to 512 columns.',
      ),
    frames: z
      .array(z.array(row).min(1).max(128).readonly())
      .min(1)
      .max(240)
      .readonly(),
  })
  .refine(
    (document) => Buffer.byteLength(JSON.stringify(document)) <= previewBytes,
    'Preview documents must fit within 2 MiB.',
  )
  .readonly();

const placementSchema = z
  .object({
    columns: z.number().int().nonnegative(),
    rows: z.number().int().nonnegative(),
    request: z.string().optional(),
  })
  .readonly();

export const previewStatusSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string(),
    frames: z.number().int().positive(),
    rows: z.number().int().positive(),
    placement: placementSchema.optional(),
  })
  .readonly();

type Placement = z.infer<typeof placementSchema>;

type PreviewDocument = z.infer<typeof previewDocumentSchema>;

export type PreviewStatus = z.infer<typeof previewStatusSchema>;

type PreviewSnapshot = Readonly<{
  document: PreviewDocument;
  status: PreviewStatus;
  startedAt: number;
}>;

export class Preview {
  private current?: PreviewSnapshot;
  private listeners = new Set<() => void>();

  get snapshot(): PreviewSnapshot | undefined {
    return this.current;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);

    return () => this.listeners.delete(listener);
  };

  show(input: PreviewDocument): PreviewStatus {
    const document = previewDocumentSchema.parse(input);

    const status = Object.freeze({
      id: randomUUID(),
      title: document.title,
      frames: document.frames.length,
      rows: Math.max(...document.frames.map((frame) => frame.length)),
    });

    this.publish(Object.freeze({ document, status, startedAt: Date.now() }));

    return status;
  }

  close(id: string): boolean {
    if (this.current?.status.id !== id) return false;

    this.clear();

    return true;
  }

  clear(): void {
    if (this.current) this.publish(undefined);
  }

  placed(id: string, placement?: Placement): void {
    const current = this.current;

    if (!current || current.status.id !== id) return;

    const previous = current.status.placement;

    if (
      previous?.columns === placement?.columns &&
      previous?.rows === placement?.rows &&
      previous?.request === placement?.request
    )
      return;

    this.publish(
      Object.freeze({
        ...current,
        status: Object.freeze({
          ...current.status,
          placement: placement && Object.freeze({ ...placement }),
        }),
      }),
    );
  }

  private publish(snapshot: PreviewSnapshot | undefined): void {
    this.current = snapshot;

    for (const listener of this.listeners) listener();
  }
}
