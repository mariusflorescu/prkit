import type { AccountId, LocalReviewEntry, PullRequestKey, PullRequestRef } from "@prkit/contracts";

export type PaletteEntry = {
  key: PullRequestKey;
  accountId: AccountId;
  ref: PullRequestRef;
  title: string;
  opened: boolean;
  /** Null when no read through this PR's own account has named them yet. */
  headBranch: string | null;
  baseBranch: string | null;
  author: string | null;
};

const fields = (entry: PaletteEntry) =>
  [
    entry.title,
    `${entry.ref.owner}/${entry.ref.repo}#${entry.ref.number}`,
    entry.accountId,
    entry.headBranch,
    entry.baseBranch,
    entry.author,
  ].flatMap((field) => (field === null ? [] : [field.toLowerCase()]));

/**
 * Every word of the query must appear in some field, in any order. An exact `#number` or
 * head branch comes first; the rest keep their order.
 */
export const searchPalette = (entries: readonly PaletteEntry[], query: string) => {
  const needle = query.trim().toLowerCase();
  const words = needle.split(/\s+/).filter((word) => word.length > 0);
  const exact = (entry: PaletteEntry) =>
    needle === `#${entry.ref.number}` ||
    needle === String(entry.ref.number) ||
    needle === entry.headBranch?.toLowerCase();
  return entries
    .filter((entry) => {
      const haystack = fields(entry);
      return words.every((word) => haystack.some((field) => field.includes(word)));
    })
    .toSorted((a, b) => Number(exact(b)) - Number(exact(a)));
};

/** Local reviews whose folder, branch or path holds every word of the query, newest first. */
export const searchLocalReviews = (entries: readonly LocalReviewEntry[], query: string) => {
  const words = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  return entries
    .filter((entry) => {
      const haystack = [entry.source.name, entry.source.branch ?? "", entry.source.path].map(
        (field) => field.toLowerCase(),
      );
      return words.every((word) => haystack.some((field) => field.includes(word)));
    })
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
};
