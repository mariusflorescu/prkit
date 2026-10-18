import * as Schema from "effect/Schema";

import type { InboxEntry, PullRequestSummary } from "./inbox.ts";

export const SIZE_BUCKETS = [
  { bucket: "XS", name: "Extra small", maxLines: 10, maxFiles: 2 },
  { bucket: "S", name: "Small", maxLines: 100, maxFiles: 5 },
  { bucket: "M", name: "Medium", maxLines: 400, maxFiles: 15 },
  { bucket: "L", name: "Large", maxLines: 1000, maxFiles: 30 },
  {
    bucket: "XL",
    name: "Extra large",
    maxLines: Number.POSITIVE_INFINITY,
    maxFiles: Number.POSITIVE_INFINITY,
  },
] as const;
export const SizeBucket = Schema.Literals(["XS", "S", "M", "L", "XL"]);
export type SizeBucket = typeof SizeBucket.Type;

export const READING = { linesPerMinute: 20, minutesPerFile: 0.5, longestMinutes: 480 } as const;

export const PullRequestSize = Schema.Struct({
  bucket: SizeBucket,
  additions: Schema.Int,
  deletions: Schema.Int,
  lines: Schema.Int,
  files: Schema.Int,
  readingMinutes: Schema.Int,
});
export type PullRequestSize = typeof PullRequestSize.Type;

const bucketIndex = (limit: "maxLines" | "maxFiles", count: number) =>
  SIZE_BUCKETS.findIndex((row) => count <= row[limit]);

/** Whether the file count, not the changed lines, puts a pull request in its bucket. */
export const sizeSetByFiles = (size: Pick<PullRequestSize, "lines" | "files">) =>
  bucketIndex("maxFiles", size.files) > bucketIndex("maxLines", size.lines);

export const pullRequestSize = (
  pr: Pick<PullRequestSummary, "additions" | "deletions" | "changedFiles">,
): PullRequestSize => {
  const lines = pr.additions + pr.deletions;
  const files = pr.changedFiles;
  const row =
    SIZE_BUCKETS[Math.max(bucketIndex("maxLines", lines), bucketIndex("maxFiles", files))];
  return {
    bucket: row?.bucket ?? "XL",
    additions: pr.additions,
    deletions: pr.deletions,
    lines,
    files,
    readingMinutes: Math.max(
      1,
      Math.ceil(lines / READING.linesPerMinute + files * READING.minutesPerFile),
    ),
  };
};

/** GitHub says a search matched you through a team, never which one. */
const ReviewWaitVia = Schema.Union([
  Schema.TaggedStruct("you", {}),
  Schema.TaggedStruct("teams", { teams: Schema.NonEmptyArray(Schema.String) }),
]);

/**
 * How long a review request has waited on the account that found it. `atLeast` means the
 * request may be older than `since`. `unknown` says why: `not-read` (the read failed or hasn't
 * run), `no-history` (GitHub's recent events don't show the request) or `unreadable` (GitHub
 * gave nothing for the pull request).
 */
export const ReviewWait = Schema.Union([
  Schema.TaggedStruct("waiting", {
    since: Schema.String,
    cause: Schema.Literals(["requested", "requested-again", "ready"]),
    via: ReviewWaitVia,
    atLeast: Schema.Boolean,
  }),
  Schema.TaggedStruct("draft", {}),
  Schema.TaggedStruct("unknown", {
    reason: Schema.Literals(["not-read", "no-history", "unreadable"]),
  }),
]);
export type ReviewWait = typeof ReviewWait.Type;

const timeOf = (iso: string) => {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? null : time;
};

export type InboxRank = ReadonlyArray<number> | null;

export const compareRanks = (left: InboxRank, right: InboxRank) => {
  if (left === null || right === null) return left === right ? 0 : left === null ? 1 : -1;
  for (const [index, value] of left.entries()) {
    const other = right[index];
    if (other === undefined) return 1;
    if (value !== other) return value < other ? -1 : 1;
  }
  return left.length < right.length ? -1 : 0;
};

export const INBOX_SORT_IDS = ["updated", "waiting", "size"] as const;
type InboxSortId = (typeof INBOX_SORT_IDS)[number];
export const DEFAULT_INBOX_SORT: InboxSortId = "updated";

/** The moment a sort orders by, and the verb a row puts before it. */
export interface InboxTime {
  readonly verb: "waiting" | "opened" | "updated";
  readonly at: string;
}

const timeRank =
  (time: (entry: InboxEntry) => InboxTime | null, direction: 1 | -1) =>
  (entry: InboxEntry): InboxRank => {
    const at = time(entry)?.at;
    const ms = at === undefined ? null : timeOf(at);
    return ms === null ? null : [ms * direction];
  };

const updatedTime = (entry: InboxEntry): InboxTime => ({ verb: "updated", at: entry.updatedAt });
const waitingTime = (entry: InboxEntry): InboxTime | null =>
  entry.wait === null
    ? { verb: "opened", at: entry.createdAt }
    : entry.wait._tag === "waiting"
      ? { verb: "waiting", at: entry.wait.since }
      : null;

interface InboxSortSpec {
  readonly label: string;
  readonly description: string;
  /** The time the sort orders by, which the row shows; null when the entry has none or the sort isn't by time. */
  readonly time: (entry: InboxEntry) => InboxTime | null;
  /** A comparable key, or null for an entry that sorts after every ranked one. */
  readonly rank: (entry: InboxEntry) => InboxRank;
}

/**
 * The Inbox's sorts. A new sort is one id in `INBOX_SORT_IDS` and one entry here; typecheck
 * fails if either is missing.
 */
export const INBOX_SORTS: Record<InboxSortId, InboxSortSpec> = {
  updated: {
    label: "Recently updated",
    description: "Most recent activity first.",
    time: updatedTime,
    rank: timeRank(updatedTime, -1),
  },
  waiting: {
    label: "Waiting longest",
    description:
      "Review requests by how long they have waited on you, longest first, then drafts and requests with no known wait. Your own and involved pull requests by how long ago they were opened.",
    time: waitingTime,
    rank: timeRank(waitingTime, 1),
  },
  size: {
    label: "Smallest first",
    description: "Smallest size first, then fewest changed lines, then fewest files.",
    time: () => null,
    rank: (entry) => {
      const size = pullRequestSize(entry);
      return [SIZE_BUCKETS.findIndex((row) => row.bucket === size.bucket), size.lines, size.files];
    },
  },
};

export const InboxSort = Schema.Literals(INBOX_SORT_IDS).annotate({
  description: `How the pull requests are ordered. ${INBOX_SORT_IDS.map((id) => `${id}: ${INBOX_SORTS[id].description}`).join(" ")}`,
});
export type InboxSort = typeof InboxSort.Type;
