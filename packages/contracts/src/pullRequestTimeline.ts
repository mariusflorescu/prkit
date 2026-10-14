import * as Schema from "effect/Schema";

import { PullRequestAuthor, PullRequestLabel } from "./inbox.ts";

const eventFields = {
  id: Schema.String,
  at: Schema.String,
  author: Schema.NullOr(PullRequestAuthor),
  url: Schema.String,
};

/** Who a review was requested from: a person or bot by login, or a team as `org/team`. */
export const TimelineReviewer = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("user"),
    login: Schema.String,
    avatarUrl: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("team"),
    slug: Schema.String,
    avatarUrl: Schema.NullOr(Schema.String),
  }),
]);
export type TimelineReviewer = typeof TimelineReviewer.Type;
/** An issue or pull request an event points at; `crossRepository` when it lives in another repository. */
export const TimelineReference = Schema.Struct({
  kind: Schema.Literals(["issue", "pull-request"]),
  repository: Schema.String,
  number: Schema.Int,
  title: Schema.String,
  url: Schema.String,
  crossRepository: Schema.Boolean,
});
export type TimelineReference = typeof TimelineReference.Type;

export const PullRequestTimelineEvent = Schema.Union([
  Schema.Struct({
    ...eventFields,
    kind: Schema.Literal("commit"),
    sha: Schema.String,
    title: Schema.String,
    additions: Schema.Int,
    deletions: Schema.Int,
  }),
  Schema.Struct({
    ...eventFields,
    kind: Schema.Literal("force-push"),
    beforeSha: Schema.NullOr(Schema.String),
    afterSha: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    ...eventFields,
    kind: Schema.Literals([
      "opened",
      "closed",
      "merged",
      "reopened",
      "ready-for-review",
      "converted-to-draft",
    ]),
  }),
  Schema.Struct({
    ...eventFields,
    kind: Schema.Literals(["labeled", "unlabeled"]),
    label: PullRequestLabel,
  }),
  Schema.Struct({
    ...eventFields,
    kind: Schema.Literals(["review-requested", "review-request-removed"]),
    reviewer: Schema.NullOr(TimelineReviewer),
  }),
  Schema.Struct({
    ...eventFields,
    kind: Schema.Literals(["assigned", "unassigned"]),
    assignee: Schema.NullOr(PullRequestAuthor),
  }),
  Schema.Struct({
    ...eventFields,
    kind: Schema.Literal("renamed"),
    previousTitle: Schema.String,
    currentTitle: Schema.String,
  }),
  Schema.Struct({
    ...eventFields,
    kind: Schema.Literal("base-changed"),
    previousBase: Schema.String,
    currentBase: Schema.String,
  }),
  Schema.Struct({
    ...eventFields,
    kind: Schema.Literal("cross-referenced"),
    source: TimelineReference,
  }),
  Schema.Struct({
    ...eventFields,
    kind: Schema.Literal("marked-as-duplicate"),
    canonical: Schema.NullOr(TimelineReference),
  }),
]);
export type PullRequestTimelineEvent = typeof PullRequestTimelineEvent.Type;
export const PullRequestTimeline = Schema.Struct({
  events: Schema.Array(PullRequestTimelineEvent),
});
export type PullRequestTimeline = typeof PullRequestTimeline.Type;
