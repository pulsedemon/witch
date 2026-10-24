export type RegisterCleanup = (cleanup: () => void | Promise<void>) => void;

/** keep dependent releases in registration order before Vitest restores mocks. */
export function orderedCleanup(register: RegisterCleanup): RegisterCleanup {
  const callbacks: (() => void | Promise<void>)[] = [];
  register(async () => {
    for (const callback of callbacks) await callback();
  });
  return (cleanup) => {
    callbacks.push(cleanup);
  };
}
