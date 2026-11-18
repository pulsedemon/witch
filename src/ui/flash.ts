import { useEffect, useRef, useState } from 'react';

/** true for `milliseconds` after each flash, which restarts the time. */
export function useFlash(milliseconds: number) {
  const [on, setOn] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const flash = () => {
    clearTimeout(timer.current);
    setOn(true);
    timer.current = setTimeout(() => setOn(false), milliseconds);
  };

  return [on, flash] as const;
}
