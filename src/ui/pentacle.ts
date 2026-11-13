/** the bit of U+2800 each braille dot sets, by row of four and column of two. */
const dots = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
];
/** half the thickness, as a share of the radius. */
const depth = 0.07;
/** leans the top away, so the thickness shows face on. */
const tilt = 0.22;
/** the viewer's distance in radii; nearer exaggerates the perspective. */
const camera = 4;
const ringSegments = 40;

interface Run {
  text: string;
  /** on the side facing the viewer. */
  near: boolean;
}

type Point = [number, number, number];

/** points around the unit circle from the top, clockwise. */
function around(count: number): [number, number][] {
  return Array.from({ length: count }, (_, index) => {
    const turn = (index / count) * 2 * Math.PI;
    return [Math.sin(turn), Math.cos(turn)];
  });
}

/** an upright star in a ring, extruded, as edges between its two faces. */
const edges: [Point, Point][] = (() => {
  const points = around(5);
  const ring = around(ringSegments);
  const result: [Point, Point][] = [];
  for (const z of [-depth, depth]) {
    const face = ([x, y]: [number, number]): Point => [x, y, z];
    points.forEach((point, index) =>
      result.push([face(point), face(points[(index + 2) % 5]!)]),
    );
    ring.forEach((point, index) =>
      result.push([face(point), face(ring[(index + 1) % ringSegments]!)]),
    );
  }
  for (const [x, y] of points)
    result.push([
      [x, y, -depth],
      [x, y, depth],
    ]);
  return result;
})();

/**
 * the pentacle turned `angle` radians about its upright axis, drawn in braille dots to fill `columns` by `rows`
 * cells: each row as runs of near and far edges, so they can take different colors.
 */
export function pentacle(
  angle: number,
  columns: number,
  rows: number,
): Run[][] {
  const width = columns * 2;
  const height = rows * 4;
  const near = new Uint8Array(columns * rows);
  const far = new Uint8Array(columns * rows);
  // a cell is twice as tall as wide, so its dots are square
  const radius = Math.min(width, height) / 2 - 1;
  const project = ([x, y, z]: Point) => {
    const turnedX = x * Math.cos(angle) + z * Math.sin(angle);
    const turnedZ = z * Math.cos(angle) - x * Math.sin(angle);
    const leanedY = y * Math.cos(tilt) - turnedZ * Math.sin(tilt);
    const leanedZ = turnedZ * Math.cos(tilt) + y * Math.sin(tilt);
    const scale = (camera / (camera + leanedZ)) * radius;
    return {
      x: width / 2 + turnedX * scale,
      y: height / 2 - leanedY * scale,
      z: leanedZ,
    };
  };
  const plot = (layer: Uint8Array, x: number, y: number) => {
    const column = Math.floor(x / 2);
    const row = Math.floor(y / 4);
    if (column < 0 || column >= columns || row < 0 || row >= rows) return;
    layer[row * columns + column]! |= dots[y % 4]![x % 2]!;
  };
  for (const [from, to] of edges) {
    const start = project(from);
    const end = project(to);
    const layer = start.z + end.z <= 0 ? near : far;
    const steps = Math.ceil(
      Math.max(Math.abs(end.x - start.x), Math.abs(end.y - start.y)),
    );
    for (let step = 0; step <= steps; step++) {
      const share = steps ? step / steps : 0;
      plot(
        layer,
        Math.round(start.x + (end.x - start.x) * share),
        Math.round(start.y + (end.y - start.y) * share),
      );
    }
  }
  return Array.from({ length: rows }, (_, row) => {
    const runs: Run[] = [];
    for (let column = 0; column < columns; column++) {
      const index = row * columns + column;
      const bits = near[index]! | far[index]!;
      const isNear = near[index]! > 0 || !bits;
      const text = bits ? String.fromCharCode(0x2800 | bits) : ' ';
      const last = runs.at(-1);
      if (last?.near === isNear) last.text += text;
      else runs.push({ text, near: isNear });
    }
    return runs;
  });
}
