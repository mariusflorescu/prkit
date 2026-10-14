import { useEffect, useState } from "react";

import { formatAgo } from "./reviewPresentation";

/** Time since the watcher's last good read. Re-renders twice a minute; nothing moves. */
export function CheckedAgo({ at }: { at: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return <time dateTime={at}>checked {formatAgo(now - Date.parse(at))}</time>;
}
