import type { InboxEntry } from "@prkit/contracts";

import { stackOrder } from "./inboxPresentation";
import { InboxRow } from "./InboxRow";

export function InboxGroup({
  title,
  entries,
  showAccount,
}: {
  title: string;
  entries: ReadonlyArray<InboxEntry>;
  showAccount: boolean;
}) {
  return (
    <section aria-label={title} className="mb-6">
      <h2 className="flex items-center gap-2 px-3 py-3 font-medium text-xs text-muted-foreground">
        {title}
        <span className="text-2xs tabular-nums">{entries.length}</span>
        <span aria-hidden className="ml-1 h-px flex-1 bg-border/60" />
      </h2>
      <ul>
        {stackOrder(entries).map((entry) => (
          <InboxRow
            key={`${entry.ref.host}/${entry.ref.owner}/${entry.ref.repo}#${entry.ref.number}`}
            entry={entry}
            showAccount={showAccount}
          />
        ))}
      </ul>
    </section>
  );
}
