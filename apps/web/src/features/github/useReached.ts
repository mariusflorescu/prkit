import { useEffect, useState } from "react";

/** Whether `at` (epoch ms) has passed; turns true at that moment, not on the next repaint. */
export function useReached(at: number | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (at === null || at <= Date.now()) return;
    const timer = window.setTimeout(() => setNow(Date.now()), at - Date.now() + 50);
    return () => window.clearTimeout(timer);
  }, [at]);
  return at === null || now >= at;
}
