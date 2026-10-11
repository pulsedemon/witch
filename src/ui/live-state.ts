import { useRef, useState } from 'react';

/** state that key handlers read through a ref, since Ink delivers every key of a chunk before it re-renders. */
export function useLiveState<T>(initial: T | (() => T)) {
  const [value, setValue] = useState(initial);
  const reference = useRef(value);
  const set = (next: T | ((previous: T) => T)) => {
    reference.current =
      typeof next === 'function'
        ? (next as (previous: T) => T)(reference.current)
        : next;
    setValue(reference.current);
  };
  return [value, reference, set] as const;
}
