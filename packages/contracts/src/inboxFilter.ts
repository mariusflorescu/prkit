import type { AccountId } from "./ids.ts";
import {
  type InboxEntry,
  InboxReason,
  inboxReasonPriority,
  primaryInboxReason,
  pullRequestKey,
} from "./inbox.ts";
import { compareRanks, INBOX_SORTS, type InboxSort } from "./inboxTriage.ts";

export const repositoryKey = (repository: { host: string; owner: string; name: string }) =>
  `${repository.host}/${repository.owner}/${repository.name}`.toLowerCase();

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
const stackOrder = (entries: ReadonlyArray<InboxEntry>) => {
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

const tiebreak = (left: InboxEntry, right: InboxEntry) =>
  right.updatedAt.localeCompare(left.updatedAt) ||
  pullRequestKey(left.ref).localeCompare(pullRequestKey(right.ref));

const REASONS_BY_PRIORITY = InboxReason.literals.toSorted(
  (left, right) => inboxReasonPriority[left] - inboxReasonPriority[right],
);

/** One group of entries in a sort's order, with a stack at its best-ranked layer. */
export const sortInboxGroup = (entries: ReadonlyArray<InboxEntry>, sort: InboxSort) => {
  const ranked = entries
    .map((entry) => ({ entry, rank: INBOX_SORTS[sort].rank(entry) }))
    .toSorted(
      (left, right) => compareRanks(left.rank, right.rank) || tiebreak(left.entry, right.entry),
    );
  return stackOrder(ranked.map((item) => item.entry));
};

/** Entries grouped by primary reason, each group in `sortInboxGroup`'s order. */
export const orderInbox = (entries: ReadonlyArray<InboxEntry>, sort: InboxSort) =>
  REASONS_BY_PRIORITY.flatMap((reason) =>
    sortInboxGroup(
      entries.filter((entry) => primaryInboxReason(entry.reasons) === reason),
      sort,
    ),
  );
