/** waits for `gate`, then extends the read's lock deadline by the wait, which stands in for a late read and mustn't expire it. */
export async function resume(
  gate: Promise<void>,
  args: [number?, ...unknown[]],
) {
  const paused = Date.now();
  await gate;

  if (args[0] !== undefined) args[0] += Date.now() - paused;
}
