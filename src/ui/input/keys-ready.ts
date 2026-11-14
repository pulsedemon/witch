import { useEffect, useState } from 'react';

/** false until `active` has held for 500 ms, so keys meant for the composer can't act on a view that just appeared. */
export function useKeysReady(active: boolean): boolean {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setReady(false);

    if (!active) return;

    const timer = setTimeout(() => setReady(true), 500);

    return () => clearTimeout(timer);
  }, [active]);

  return ready;
}
