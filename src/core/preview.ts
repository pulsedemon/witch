import { randomUUID } from 'node:crypto';
import { tokenize } from '@alcalzone/ansi-tokenize';
import stringWidth from 'string-width';
import { z } from 'zod';

export const previewBytes = 2 * 1024 * 1024;
const controls = /\p{Cc}/u;
const sgr = new Set(['', '0', '1', '2', '22', '39', '49']);

function formattedRow(text: string): boolean {
  // compound SGR tokenization rewrites C1 introducers, so inspect raw controls first.
  for (const character of text)
    if (character !== '\u001b' && controls.test(character)) return false;

  return tokenize(text).every((token) => {
    if (token.type === 'char') return !controls.test(token.value);

    if (token.type !== 'ansi') return false;

    if (!token.code.startsWith('\u001b[') || !token.code.endsWith('m'))
      return false;

    const code = token.code.slice(2, -1);

    if (sgr.has(code)) return true;

    const color = /^(?:38|48);2;(\d{1,3});(\d{1,3});(\d{1,3})$/u.exec(code);

    return !!color && color.slice(1).every((channel) => Number(channel) <= 255);
  });
}

const row = z
  .string()
  .refine(
    (text) => formattedRow(text) && stringWidth(text) <= 512,
    'Preview rows allow text and restricted SGR formatting, up to 512 columns.',
  );

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

export type PreviewDocument = z.infer<typeof previewDocumentSchema>;

export type PreviewStatus = z.infer<typeof previewStatusSchema>;

export type PreviewSnapshot = Readonly<{
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
