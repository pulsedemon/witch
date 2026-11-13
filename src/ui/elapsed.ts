export function elapsed(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  return seconds < 60
    ? `${seconds}S`
    : `${Math.floor(seconds / 60)}M${String(seconds % 60).padStart(2, '0')}S`;
}
