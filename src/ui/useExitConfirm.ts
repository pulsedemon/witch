import { useEffect, useRef } from 'react';
import { useLiveState } from './useLiveState.js';

/** exits on a second press within a second, so one stray Ctrl+C doesn't end Witch. */
export function useExitConfirm(onExit: () => void) {
  const [armed, armedRef, setArmed] = useLiveState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  return {
    armed,
    press() {
      clearTimeout(timer.current);

      if (armedRef.current) return onExit();

      setArmed(true);
      timer.current = setTimeout(() => setArmed(false), 1000);
    },
  };
}
