import { ago } from "~/features/github/freshness";
import { useNow } from "~/features/github/useNow";

/** How old the inbox is: the oldest answer among the accounts in view. */
export function InboxUpdated({ fetchedAt }: { fetchedAt: string | null }) {
  const now = useNow();
  if (fetchedAt === null) return null;
  return (
    <p data-inbox-updated={fetchedAt} className="text-xs text-muted-foreground">
      Updated {ago(fetchedAt, now)}
    </p>
  );
}
