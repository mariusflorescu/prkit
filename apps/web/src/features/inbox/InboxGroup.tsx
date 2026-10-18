import { type InboxEntry, type InboxSort, sortInboxGroup } from "@prkit/contracts";

import { rowClock } from "./inboxPresentation";
import { InboxRow } from "./InboxRow";

export function InboxGroup({
  title,
  entries,
  sort,
  showAccount,
}: {
  title: string;
  entries: ReadonlyArray<InboxEntry>;
  sort: InboxSort;
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
        {sortInboxGroup(entries, sort).map((entry) => (
          <InboxRow
            key={`${entry.ref.host}/${entry.ref.owner}/${entry.ref.repo}#${entry.ref.number}`}
            entry={entry}
            clock={rowClock(entry, sort)}
            showAccount={showAccount}
          />
        ))}
      </ul>
    </section>
  );
}
