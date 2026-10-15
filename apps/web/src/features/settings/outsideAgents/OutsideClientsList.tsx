import type { OutsideClient } from "@prkit/contracts";

import { relativeTime } from "~/features/pullRequest/pullRequestPresentation";

/** The clients that called prkit in the last day, by the name they gave. */
export function OutsideClientsList({ clients }: { clients: readonly OutsideClient[] }) {
  return (
    <div className="border-t border-border/60 py-3">
      <p className="text-sm">Connected clients</p>
      {clients.length === 0 ? (
        <p role="status" className="mt-1 text-xs text-muted-foreground">
          None yet. A client shows here after its first call.
        </p>
      ) : (
        <ul aria-label="Connected clients" className="mt-1">
          {clients.map((client) => (
            <li
              key={client.id}
              className="flex min-h-10 items-center justify-between gap-3 border-b border-border/60 py-2 last:border-0"
            >
              <span className="truncate text-sm">{client.name}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {relativeTime(client.lastSeenAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
