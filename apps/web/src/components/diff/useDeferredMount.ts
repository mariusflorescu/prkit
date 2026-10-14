import { useEffect, useRef, useState } from "react";

import { queueIdleMount } from "./idleMount";

export function useDeferredMount() {
  const ref = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (ready || !ref.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setReady(true);
      },
      { rootMargin: "900px 0px" },
    );
    observer.observe(ref.current);
    const cancel = queueIdleMount(() => setReady(true));
    return () => {
      observer.disconnect();
      cancel();
    };
  }, [ready]);
  return { ref, ready };
}
