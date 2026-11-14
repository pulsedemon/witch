import { randomBytes } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';

/** a valid grayscale PNG of noise, which deflate cannot shrink, so a large one spans several protocol chunks. */
export function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4);

    length.writeUInt32BE(data.length);

    const crc = Buffer.alloc(4);

    crc.writeUInt32BE(crc32(body));

    return Buffer.concat([length, body, crc]);
  };

  const header = Buffer.alloc(13);

  header.writeUInt32BE(width, 0);

  header.writeUInt32BE(height, 4);

  header[8] = 8;
  const pixels = randomBytes((width + 1) * height);

  // each row starts with filter type 0
  for (let row = 0; row < height; row++) pixels[row * (width + 1)] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
