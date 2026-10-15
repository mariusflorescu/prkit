import type { AccountId } from "./ids.ts";
import type { InboxEntry, InboxReason } from "./inbox.ts";

export const repositoryKey = (repository: { host: string; owner: string; name: string }) =>
  `${repository.host}/${repository.owner}/${repository.name}`.toLowerCase();

/** The Inbox and outside readers use exactly the same matching and stack ordering. */
export const matchesInboxFilter = (
  entry: InboxEntry,
  search: string,
  account: AccountId | null,
  repository: { host: string; owner: string; name: string } | null,
  filters: {
    readonly reason?: InboxReason;
    readonly state?: InboxEntry["state"];
    readonly draft?: boolean;
    readonly checks?: "passing" | "failing" | "pending" | "none";
    readonly stacks?: "all" | "stacked" | "unstacked";
  } = {},
) => {
  if (account !== null && entry.accountId !== account) return false;
  if (
    repository !== null &&
    repositoryKey({ ...entry.ref, name: entry.ref.repo }) !== repositoryKey(repository)
  )
    return false;
  if (filters.reason !== undefined && !entry.reasons.includes(filters.reason)) return false;
  if (filters.state !== undefined && entry.state !== filters.state) return false;
  if (filters.draft !== undefined && entry.isDraft !== filters.draft) return false;
  if (filters.checks !== undefined && (entry.checks ?? "none") !== filters.checks) return false;
  if (filters.stacks === "stacked" && entry.stack === null) return false;
  if (filters.stacks === "unstacked" && entry.stack !== null) return false;
  const needle = search.trim().toLowerCase();
  const number = String(entry.ref.number);
  return (
    needle === "" ||
    [
      entry.title,
      `${entry.ref.owner}/${entry.ref.repo}`,
      entry.author?.login ?? "",
      number,
      `#${number}`,
    ].some((value) => value.toLowerCase().includes(needle))
  );
};

const stackId = (entry: InboxEntry) =>
  entry.stack === null
    ? null
    : `${entry.ref.host}/${entry.ref.owner}/${entry.ref.repo}/${entry.stack.number}`;
export const stackOrder = (entries: ReadonlyArray<InboxEntry>) => {
  const layers = new Map<string, Array<InboxEntry>>();
  for (const entry of entries) {
    const id = stackId(entry);
    if (id !== null) layers.set(id, [...(layers.get(id) ?? []), entry]);
  }
  const placed = new Set<string>();
  return entries.flatMap((entry) => {
    const id = stackId(entry);
    if (id === null) return [entry];
    if (placed.has(id)) return [];
    placed.add(id);
    return (layers.get(id) ?? []).toSorted(
      (left, right) => (left.stack?.position ?? 0) - (right.stack?.position ?? 0),
    );
  });
};
