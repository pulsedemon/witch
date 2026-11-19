import { useEffect, useState } from 'react';

/** the step every animation shares. */
export const tickMs = 50;
const listeners = new Set<(tick: number) => void>();
let timer: ReturnType<typeof setTimeout> | undefined;
const current = () => Math.floor(Date.now() / tickMs);

function wait() {
  if (timer !== undefined || !listeners.size) return;

  timer = setTimeout(
    () => {
      timer = undefined;
      const tick = current();

      for (const listener of listeners) listener(tick);

      wait();
    },
    tickMs - (Date.now() % tickMs),
  );
}

function subscribe(listener: (tick: number) => void) {
  listeners.add(listener);
  wait();

  return () => {
    listeners.delete(listener);

    if (!listeners.size) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
}

/** animations share one timer so their updates can batch before Ink's frame cap. */
export function useTick(every = 1, active = true): number {
  const [clock, setClock] = useState(() => ({
    every,
    active,
    step: Math.floor(current() / every),
  }));

  let step = clock.step;

  if (clock.every !== every || clock.active !== active) {
    step = Math.floor(current() / every);
    setClock({ every, active, step });
  }

  useEffect(() => {
    if (!active) return;

    const read = (tick: number) => {
      const step = Math.floor(tick / every);

      setClock((previous) =>
        previous.every !== every ||
        previous.active !== active ||
        previous.step === step
          ? previous
          : { ...previous, step },
      );
    };

    read(current());

    return subscribe(read);
  }, [every, active]);

  return active ? step : Math.floor(current() / every);
}
