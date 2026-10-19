import {
  type AccountId,
  type InboxEntry,
  type InboxFilters,
  type InboxReason,
  INBOX_SORTS,
  type InboxSort,
  type InboxTime,
  type PullRequestSummary,
  type Repository,
  type RepositoryFilter,
  type RepositoryList,
} from "@prkit/contracts";

import type { SearchPickerGroup } from "~/components/ui/search-picker";

import { formatEventDate, waitEvidence } from "./triageCopy";

export const INBOX_GROUPS = [
  { reason: "review-requested", title: "Needs your review" },
  { reason: "authored", title: "Yours" },
  { reason: "involved", title: "Involved" },
] satisfies ReadonlyArray<{ reason: InboxReason; title: string }>;

export { matchesInboxFilter } from "@prkit/contracts";
import { repositoryKey } from "@prkit/contracts";
export { repositoryKey };
const entryRepository = (entry: PullRequestSummary) => ({
  host: entry.ref.host,
  owner: entry.ref.owner,
  name: entry.ref.repo,
});

/**
 * Whether a saved repository filter names a repository no account sees any more: every
 * account's list was read whole after the filter was saved, and neither the list nor the
 * inbox has it. A list read before the save may predate the repository.
 */
export const repositoryGone = (
  list: RepositoryList,
  entries: ReadonlyArray<InboxEntry>,
  repository: RepositoryFilter,
  savedAt: string,
) => {
  const key = repositoryKey(repository);
  return (
    list.accounts.every(
      (row) =>
        row.fetchedAt !== null &&
        Date.parse(row.fetchedAt) > Date.parse(savedAt) &&
        row.problem === null &&
        row.total === null,
    ) &&
    !list.repositories.some((item) => repositoryKey(item) === key) &&
    !entries.some((entry) => repositoryKey(entryRepository(entry)) === key)
  );
};

export const sameRepository = (left: RepositoryFilter | null, right: RepositoryFilter | null) =>
  left === null || right === null
    ? left === right
    : repositoryKey(left) === repositoryKey(right) &&
      left.accountIds.join() === right.accountIds.join();

export const sameFilters = (left: InboxFilters, right: InboxFilters) =>
  left.search === right.search &&
  left.account === right.account &&
  left.sort === right.sort &&
  sameRepository(left.repository, right.repository);

/**
 * Saved filters without the accounts removed since: an account filter on one shows every
 * account, and a repository is read through the accounts left, or dropped when none is.
 */
export const withLiveAccounts = (
  saved: InboxFilters,
  accounts: ReadonlyArray<AccountId>,
): InboxFilters => {
  const live = new Set(accounts);
  const [reader, ...others] = saved.repository?.accountIds.filter((id) => live.has(id)) ?? [];
  return {
    search: saved.search,
    sort: saved.sort,
    account: saved.account !== null && live.has(saved.account) ? saved.account : null,
    repository:
      saved.repository === null || reader === undefined
        ? null
        : { ...saved.repository, accountIds: [reader, ...others] },
  };
};

const relativeTime = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const TIME_UNITS = [
  ["month", 2_592_000],
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
] as const;
const elapsed = (since: string) => {
  const seconds = Math.max(0, (Date.now() - Date.parse(since)) / 1000);
  const unit = TIME_UNITS.find(([, size]) => seconds >= size);
  return unit === undefined ? null : { name: unit[0], count: Math.floor(seconds / unit[1]) };
};
export const relativeUpdatedTime = (updatedAt: string) => {
  const time = elapsed(updatedAt);
  return time === null ? "just now" : relativeTime.format(-time.count, time.name);
};
const waitDuration = (since: string, atLeast: boolean) => {
  const time = elapsed(since);
  return time === null
    ? "under a minute"
    : `${time.count}${atLeast ? "+" : ""} ${time.name}${time.count === 1 ? "" : "s"}`;
};

export interface RowClock {
  readonly at: string;
  readonly label: string;
  readonly evidence: string;
}

const CLOCK_EVIDENCE = { waiting: "Waiting since", opened: "Opened", updated: "Last updated" };
const clockOf = (time: InboxTime): RowClock => ({
  at: time.at,
  label: `${time.verb} ${relativeUpdatedTime(time.at)}`,
  evidence: `${CLOCK_EVIDENCE[time.verb]} ${formatEventDate(time.at)}.`,
});

export const updatedClock = (pr: PullRequestSummary) =>
  clockOf({ verb: "updated", at: pr.updatedAt });

/** A running wait shows under any sort; otherwise the time the sort orders by, else when it was updated. */
export const rowClock = (entry: InboxEntry, sort: InboxSort): RowClock => {
  const wait = entry.wait;
  if (wait?._tag === "waiting")
    return {
      at: wait.since,
      label: `waiting ${waitDuration(wait.since, wait.atLeast)}`,
      evidence: waitEvidence(wait),
    };
  const time = INBOX_SORTS[sort].time(entry);
  const clock = time === null ? updatedClock(entry) : clockOf(time);
  return wait === null ? clock : { ...clock, evidence: `${waitEvidence(wait)} ${clock.evidence}` };
};

/** A row of the repository filter: every repository, or one with its inbox count. */
export type RepositoryChoice =
  | { readonly _tag: "all"; readonly key: "all" }
  | (RepositoryFilter & {
      readonly _tag: "repository";
      readonly key: string;
      readonly count: number;
    });

export const ALL_REPOSITORIES: RepositoryChoice = { _tag: "all", key: "all" };

/**
 * The repository filter's rows, grouped by owner: every repository the accounts in view
 * can see, plus any the inbox lists that the list doesn't (it may be cut or still
 * loading), each with how many inbox pull requests it has.
 */
export const repositoryChoices = (
  repositories: ReadonlyArray<Repository>,
  entries: ReadonlyArray<InboxEntry>,
  account: AccountId | null,
): ReadonlyArray<SearchPickerGroup<RepositoryChoice>> => {
  const counts = new Map<string, number>();
  const found = new Map<string, RepositoryFilter>();
  for (const entry of entries) {
    if (account !== null && entry.accountId !== account) continue;
    const key = repositoryKey(entryRepository(entry));
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (!found.has(key))
      found.set(key, { ...entryRepository(entry), accountIds: [entry.accountId] });
  }
  for (const repository of repositories) {
    const readers = repository.accountIds.filter((id) => account === null || id === account);
    const [first, ...rest] = readers;
    if (first !== undefined)
      found.set(repositoryKey(repository), { ...repository, accountIds: [first, ...rest] });
  }
  const byOwner = new Map<string, Array<RepositoryChoice>>();
  for (const [key, repository] of found) {
    const owner = `${repository.host}/${repository.owner}`;
    byOwner.set(owner, [
      ...(byOwner.get(owner) ?? []),
      { ...repository, _tag: "repository", key, count: counts.get(key) ?? 0 },
    ]);
  }
  const groups = [...byOwner]
    .toSorted(([left], [right]) => left.localeCompare(right, undefined, { sensitivity: "base" }))
    .map(([owner, choices]) => ({
      value: owner,
      label: owner.startsWith("github.com/") ? owner.slice("github.com/".length) : owner,
      items: choices.toSorted((left, right) =>
        left.key.localeCompare(right.key, undefined, { sensitivity: "base" }),
      ),
    }));
  return [{ value: "all", label: null, items: [ALL_REPOSITORIES] }, ...groups];
};
