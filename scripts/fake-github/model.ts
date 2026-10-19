// The fake GitHub's pull requests, history and counters, shared by its GraphQL and REST answers.
import * as NodeCrypto from "node:crypto";

import * as Schema from "effect/Schema";

import { STACKS } from "./options.ts";

export const LOGIN = "budget-test";
export const SECOND_LOGIN = "budget-second";
export const OWNER = "budget";
export const REPO = "fixtures";
export const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json));

export const iso = (ms: number) => new Date(ms).toISOString();
export const sha = (seed: string) => NodeCrypto.createHash("sha1").update(seed).digest("hex");
export const start = Date.now() - 3_600_000;

type MergeMethod = "MERGE" | "SQUASH" | "REBASE";
export type Reviewer = { kind: "user"; login: string } | { kind: "team"; slug: string };
export const sameReviewer = (left: Reviewer, right: Reviewer) =>
  left.kind === "user"
    ? right.kind === "user" && left.login === right.login
    : right.kind === "team" && left.slug === right.slug;
export type ReviewEvent =
  | { kind: "requested"; at: number; reviewer: Reviewer }
  | { kind: "ready"; at: number };
export interface Pull {
  number: number;
  title: string;
  author: string;
  association: string;
  headRepo: string;
  updatedAt: number;
  heads: Array<{ sha: string; at: number; message: string }>;
  comments: Array<{ id: number; body: string; at: number }>;
  checks: "queued" | "in_progress" | "completed";
  state: "OPEN" | "MERGED" | "CLOSED";
  draft: boolean;
  /** Commits its base has that its head doesn't. */
  behindBy: number;
  mergedAt: number | null;
  conflicting: boolean;
  /** GitHub hasn't worked out yet whether it merges cleanly. */
  checking: boolean;
  /** The base requires the `build` check to pass before merging. */
  required: boolean;
  autoMerge: MergeMethod | null;
  reviews: Array<{ id: number; login: string; state: string; body: string; at: number }>;
  /** Workflow runs on the head; a fork's wait for approval until someone approves them. */
  runs: Array<{ id: number; status: string; conclusion: string | null }>;
  createdAt: number;
  size: { additions: number; deletions: number; files: number };
  requested: Array<Reviewer>;
  reviewEvents: Array<ReviewEvent>;
  /** Its description; null answers `Body of fixture <number>`. */
  body: string | null;
}
/** What a pull request starts with for what the inbox shows of it; each call gives it lists of its own. */
export const pullDefaults = (): Pick<
  Pull,
  "createdAt" | "size" | "requested" | "reviewEvents" | "body"
> => ({
  createdAt: start,
  size: { additions: 1, deletions: 0, files: 1 },
  requested: [],
  reviewEvents: [],
  body: null,
});
export const unreadable = new Set<number>();
export const pulls = new Map<number, Pull>();
export const servedFiles = new Map<
  number,
  ReadonlyArray<{
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    patch?: string;
  }>
>();
/**
 * What pushes did to a file after the commit that added it, keyed `<pr>:<file index>`:
 * `edits` rewrote its text, `shifts` moved its hunk to other line numbers like a merged base.
 */
export const fileChanges = new Map<string, { edits: number; shifts: number }>();
/** File text at a PR's head, by path, for the diff viewer's text reads. */
export const servedTexts = new Map<number, ReadonlyMap<string, string>>();
for (let number = 1; number <= 6; number++)
  pulls.set(number, {
    number,
    title: `Budget fixture ${number}`,
    author: LOGIN,
    association: "OWNER",
    headRepo: `${OWNER}/${REPO}`,
    updatedAt: start + number * 60_000,
    heads: [{ sha: sha(`${number}-0`), at: start, message: `Start fixture ${number}` }],
    comments: [{ id: number * 1000, body: `First comment on ${number}`, at: start }],
    checks: "completed",
    state: "OPEN",
    draft: false,
    behindBy: 0,
    mergedAt: null,
    conflicting: false,
    checking: false,
    required: false,
    autoMerge: null,
    reviews: [],
    runs: [],
    ...pullDefaults(),
    requested: number <= 3 ? [{ kind: "user", login: LOGIN }] : [],
    reviewEvents:
      number <= 3
        ? [{ kind: "requested", at: start, reviewer: { kind: "user", login: LOGIN } }]
        : [],
  });
pulls.set(7, {
  number: 7,
  title: "Budget fixture 7 from a fork",
  author: "outsider",
  association: "CONTRIBUTOR",
  headRepo: `outsider/${REPO}`,
  updatedAt: start + 7 * 60_000,
  heads: [{ sha: sha("7-0"), at: start, message: "Start fixture 7" }],
  comments: [{ id: 7000, body: "First comment on 7", at: start }],
  checks: "completed",
  state: "OPEN",
  draft: false,
  behindBy: 0,
  mergedAt: null,
  conflicting: false,
  checking: false,
  required: false,
  autoMerge: null,
  reviews: [],
  runs: [{ id: 7001, status: "completed", conclusion: "action_required" }],
  ...pullDefaults(),
});
pulls.set(8, {
  number: 8,
  title: "Timeline fixture 8",
  author: LOGIN,
  association: "OWNER",
  headRepo: `${OWNER}/${REPO}`,
  updatedAt: start + 8 * 60_000,
  heads: [{ sha: sha("8-0"), at: Date.parse("2026-03-02T10:00:00Z"), message: "Start fixture 8" }],
  comments: [],
  checks: "completed",
  state: "OPEN",
  draft: false,
  behindBy: 0,
  mergedAt: null,
  conflicting: false,
  checking: false,
  required: false,
  autoMerge: null,
  reviews: [],
  runs: [],
  ...pullDefaults(),
});
pulls.set(9, {
  number: 9,
  title: "Keyboard fixture 9",
  author: "outsider",
  association: "CONTRIBUTOR",
  headRepo: `${OWNER}/${REPO}`,
  updatedAt: start + 9 * 60_000,
  heads: [{ sha: sha("9-0"), at: start, message: "Start fixture 9" }],
  comments: [],
  checks: "completed",
  state: "OPEN",
  draft: false,
  behindBy: 0,
  mergedAt: null,
  conflicting: false,
  checking: false,
  required: false,
  autoMerge: null,
  reviews: [],
  runs: [],
  ...pullDefaults(),
});
const person = (login: string) => ({ __typename: "User", login, avatarUrl: "" });
const pullReference = (repository: string, number: number, title: string) => ({
  __typename: "PullRequest",
  number,
  title,
  url: `https://github.com/${repository}/pull/${number}`,
  repository: { nameWithOwner: repository },
});
/** A mention from a repository the account can't see. */
export const WITHHELD = pullReference(`${OWNER}/private`, 4, "Private fixture 4");
/** PR 8's events after its first commit, as GitHub's timeline answers them, oldest first. */
export const HISTORY = (
  [
    ["10:01:00", LOGIN, "LabeledEvent", { label: { name: "bug", color: "d73a4a" } }],
    ["10:01:02", LOGIN, "LabeledEvent", { label: { name: "ui", color: "fef2c0" } }],
    ["10:05:00", LOGIN, "ReviewRequestedEvent", { requestedReviewer: person("octocat") }],
    [
      "10:05:01",
      LOGIN,
      "ReviewRequestedEvent",
      {
        requestedReviewer: {
          __typename: "Team",
          combinedSlug: `${OWNER}/reviewers`,
          avatarUrl: null,
        },
      },
    ],
    [
      "10:20:00",
      LOGIN,
      "RenamedTitleEvent",
      { previousTitle: "Timeline fixture", currentTitle: "Timeline fixture 8" },
    ],
    ["10:30:00", LOGIN, "AssignedEvent", { assignee: person(LOGIN) }],
    ["10:40:00", "octocat", "AssignedEvent", { assignee: person("teammate") }],
    ["10:40:05", "octocat", "UnassignedEvent", { assignee: person(LOGIN) }],
    [
      "11:00:00",
      LOGIN,
      "BaseRefChangedEvent",
      { previousRefName: "release", currentRefName: "main" },
    ],
    [
      "11:10:00",
      "teammate",
      "CrossReferencedEvent",
      { isCrossRepository: true, source: pullReference(`${OWNER}/tools`, 1, "Tools fixture 1") },
    ],
    ["11:15:00", "teammate", "CrossReferencedEvent", { isCrossRepository: true, source: WITHHELD }],
    ["11:20:00", LOGIN, "UnlabeledEvent", { label: { name: "ui", color: "fef2c0" } }],
    ["11:20:01", LOGIN, "LabeledEvent", { label: { name: "docs", color: "0075ca" } }],
    ["11:30:00", LOGIN, "ReviewRequestRemovedEvent", { requestedReviewer: person("octocat") }],
    [
      "11:40:00",
      "octocat",
      "MarkedAsDuplicateEvent",
      {
        isCrossRepository: false,
        canonical: pullReference(`${OWNER}/${REPO}`, 3, "Budget fixture 3"),
      },
    ],
    ["12:00:00", LOGIN, "LabeledEvent", { label: { name: "wontfix", color: "ffffff" } }],
    ["12:10:00", LOGIN, "UnlabeledEvent", { label: { name: "wontfix", color: "ffffff" } }],
    ["12:20:00", LOGIN, "ConvertToDraftEvent", {}],
    ["12:21:00", LOGIN, "ReadyForReviewEvent", {}],
    [
      "12:30:00",
      LOGIN,
      "HeadRefForcePushedEvent",
      {
        beforeCommit: { oid: "c0ffee1c0ffee1c0ffee1c0ffee1c0ffee1c0ffe" },
        afterCommit: { oid: "decafbadecafbadecafbadecafbadecafbadecaf" },
      },
    ],
    ["12:40:00", null, "LabeledEvent", { label: { name: "stale", color: "000000" } }],
  ] as const
).map(([time, actor, __typename, fields], index) =>
  Object.assign(
    {
      __typename,
      id: `event-8-${index}`,
      createdAt: `2026-03-02T${time}Z`,
      actor: actor === null ? null : person(actor),
    },
    fields,
  ),
);
export const BASE = sha("base");
/** The open PR in `budget/tools`: by a teammate, asking nobody, so no inbox search finds it. */
export const TOOLS_PULL = {
  number: 1,
  title: "Tools fixture 1",
  author: "teammate",
  association: "MEMBER",
  headRepo: `${OWNER}/tools`,
  updatedAt: start + 30 * 60_000,
};
/** PRs 1 and 2 are stack 900's layers, bottom to top. */
export const STACK = [1, 2];
export const position = (pull: Pull) => STACK.indexOf(pull.number) + 1;
export const stackFields = (pull: Pull) =>
  !STACKS
    ? {}
    : position(pull) === 0
      ? { stack: null, stackEntry: null }
      : {
          stack: { number: 900, size: STACK.length, baseRefName: "main" },
          stackEntry: { position: position(pull) },
        };
export const head = (pull: Pull) => pull.heads.at(-1)?.sha ?? BASE;
export const nodeId = (pull: Pull) => `pull-${pull.number}`;
export const mergeState = (pull: Pull) =>
  pull.state !== "OPEN"
    ? "CLEAN"
    : pull.checking
      ? "UNKNOWN"
      : pull.conflicting
        ? "DIRTY"
        : pull.draft
          ? "DRAFT"
          : pull.required && pull.checks !== "completed"
            ? "BLOCKED"
            : "CLEAN";
export const rollup = (pull: Pull) =>
  !pull.required || pull.checks === "completed" ? "SUCCESS" : "PENDING";
export const writes: Array<{ at: string; kind: string; input: Schema.Json }> = [];
export const wrote = (kind: string, input: Schema.Json) => {
  writes.push({ at: iso(Date.now()), kind, input });
};

/** Repositories archived through the control; `attic` always is. */
export const archived = new Set(["attic"]);
/** A login's inbox searches find only these pull requests; a login not here finds them all. */
export const inboxOnly = new Map<string, ReadonlySet<number>>();
type Stats = {
  since: string;
  requests: number;
  /** GraphQL points, as GitHub's `rateLimit.cost` would report them. */
  points: number;
  /** REST requests that count against the core limit (a 304 doesn't). */
  rest: number;
  /** Requests GitHub refused for the rate limit: prkit should send one, then wait. */
  refused: number;
  /** Merged PRs an inbox search still found, as GitHub's index does just after a merge. */
  mergedInSearch: number;
  byKind: Record<string, number>;
  log: Array<{ at: string; kind: string; status: number; cost: number; login: string }>;
};
const emptyStats = (): Stats => ({
  since: iso(Date.now()),
  requests: 0,
  points: 0,
  rest: 0,
  refused: 0,
  mergedInSearch: 0,
  byKind: {},
  log: [],
});
export let stats = emptyStats();
export const resetStats = () => {
  stats = emptyStats();
};
export const headRef = (pull: Pull) => `feature-${pull.number}`;
export const merge = (pull: Pull) => {
  pull.state = "MERGED";
  pull.mergedAt = Date.now();
  pull.autoMerge = null;
  pull.updatedAt = Date.now();
};
