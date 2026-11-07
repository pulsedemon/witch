export const defaultCompactionPercent = 80;

export function compactionThreshold(contextWindow: number): {
  percent: number;
  tokens: number;
} {
  const tokens = Math.floor(
    Math.min((contextWindow * defaultCompactionPercent) / 100, 600_000),
  );
  return { percent: (tokens / contextWindow) * 100, tokens };
}
