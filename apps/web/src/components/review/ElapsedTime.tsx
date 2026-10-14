import { useEffect, useState } from "react";

import { formatElapsed } from "./reviewPresentation";

/** Seconds since `since`, updated once a second. */
export function ElapsedTime({ since }: { since: string }) {
  const started = Date.parse(since);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <time dateTime={since} className="tabular-nums" aria-label="Time elapsed">
      {formatElapsed(now - started)}
    </time>
  );
}
