import {
  type AccountId,
  type PullRequestRef,
  type PullRequestTimelineEvent,
  type TimelineReference,
} from "@prkit/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { nodesOf } from "../github/connection.ts";
import {
  GitHubApi,
  GitHubRequestError,
  type GraphQLError,
  queryFailure,
} from "../github/GitHubApi.ts";

const Actor = Schema.Struct({ login: Schema.String, avatarUrl: Schema.String });
const fields = {
  id: Schema.String,
  createdAt: Schema.String,
  actor: Schema.NullOr(Actor),
};
/**
 * A reviewer or assignee. GitHub answers with a union (user, bot, mannequin, team, enterprise
 * team, organization); its fields are optional here so a member GitHub adds later reads as
 * nobody instead of failing the whole timeline.
 */
const Someone = Schema.Struct({
  login: Schema.optionalKey(Schema.String),
  combinedSlug: Schema.optionalKey(Schema.String),
  avatarUrl: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const Reference = Schema.Struct({
  __typename: Schema.Literals(["Issue", "PullRequest"]),
  number: Schema.Int,
  title: Schema.String,
  url: Schema.String,
  repository: Schema.Struct({ nameWithOwner: Schema.String }),
});
const Node = Schema.Union([
  Schema.Struct({
    __typename: Schema.Literal("PullRequestCommit"),
    commit: Schema.Struct({
      oid: Schema.String,
      messageHeadline: Schema.String,
      committedDate: Schema.String,
      additions: Schema.Int,
      deletions: Schema.Int,
      url: Schema.String,
      author: Schema.NullOr(Schema.Struct({ user: Schema.NullOr(Actor) })),
    }),
  }),
  Schema.Struct({
    ...fields,
    __typename: Schema.Literal("HeadRefForcePushedEvent"),
    beforeCommit: Schema.NullOr(Schema.Struct({ oid: Schema.String })),
    afterCommit: Schema.NullOr(Schema.Struct({ oid: Schema.String })),
  }),
  Schema.Struct({
    ...fields,
    __typename: Schema.Literals([
      "MergedEvent",
      "ClosedEvent",
      "ReopenedEvent",
      "ReadyForReviewEvent",
      "ConvertToDraftEvent",
    ]),
  }),
  Schema.Struct({
    ...fields,
    __typename: Schema.Literals(["LabeledEvent", "UnlabeledEvent"]),
    label: Schema.Struct({ name: Schema.String, color: Schema.String }),
  }),
  Schema.Struct({
    ...fields,
    __typename: Schema.Literals(["ReviewRequestedEvent", "ReviewRequestRemovedEvent"]),
    requestedReviewer: Schema.NullOr(Someone),
  }),
  Schema.Struct({
    ...fields,
    __typename: Schema.Literals(["AssignedEvent", "UnassignedEvent"]),
    assignee: Schema.NullOr(Someone),
  }),
  Schema.Struct({
    ...fields,
    __typename: Schema.Literal("RenamedTitleEvent"),
    previousTitle: Schema.String,
    currentTitle: Schema.String,
  }),
  Schema.Struct({
    ...fields,
    __typename: Schema.Literal("BaseRefChangedEvent"),
    previousRefName: Schema.String,
    currentRefName: Schema.String,
  }),
  Schema.Struct({
    ...fields,
    __typename: Schema.Literal("CrossReferencedEvent"),
    isCrossRepository: Schema.Boolean,
    source: Reference,
  }),
  Schema.Struct({
    ...fields,
    __typename: Schema.Literal("MarkedAsDuplicateEvent"),
    isCrossRepository: Schema.Boolean,
    canonical: Schema.NullOr(Reference),
  }),
]);
const Response = Schema.Struct({
  repository: Schema.NullOr(
    Schema.Struct({
      pullRequest: Schema.NullOr(
        Schema.Struct({
          timelineItems: Schema.Struct({
            /** Decoded one at a time, so one item prkit can't read doesn't hide the rest. */
            nodes: nodesOf(Schema.Json),
            pageInfo: Schema.Struct({
              hasNextPage: Schema.Boolean,
              endCursor: Schema.NullOr(Schema.String),
            }),
          }),
        }),
      ),
    }),
  ),
});

const eventSelection = "id createdAt actor { login avatarUrl }";
const assigneeSelection = "{ ... on Actor { login avatarUrl } }";
const reviewerSelection =
  "{ ... on Actor { login avatarUrl } ... on Team { combinedSlug avatarUrl } }";
const referenceSelection = `{ __typename
  ... on Issue { number title url repository { nameWithOwner } }
  ... on PullRequest { number title url repository { nameWithOwner } } }`;
/** What the query selects for each item type it asks for; `itemTypes` comes from the keys. */
const selections = {
  PullRequestCommit: `commit {
    oid messageHeadline committedDate additions deletions url author { user { login avatarUrl } }
  }`,
  HeadRefForcePushedEvent: `${eventSelection} beforeCommit { oid } afterCommit { oid }`,
  MergedEvent: eventSelection,
  ClosedEvent: eventSelection,
  ReopenedEvent: eventSelection,
  ReadyForReviewEvent: eventSelection,
  ConvertToDraftEvent: eventSelection,
  LabeledEvent: `${eventSelection} label { name color }`,
  UnlabeledEvent: `${eventSelection} label { name color }`,
  ReviewRequestedEvent: `${eventSelection} requestedReviewer ${reviewerSelection}`,
  ReviewRequestRemovedEvent: `${eventSelection} requestedReviewer ${reviewerSelection}`,
  AssignedEvent: `${eventSelection} assignee ${assigneeSelection}`,
  UnassignedEvent: `${eventSelection} assignee ${assigneeSelection}`,
  RenamedTitleEvent: `${eventSelection} previousTitle currentTitle`,
  BaseRefChangedEvent: `${eventSelection} previousRefName currentRefName`,
  CrossReferencedEvent: `${eventSelection} isCrossRepository source ${referenceSelection}`,
  MarkedAsDuplicateEvent: `${eventSelection} isCrossRepository canonical ${referenceSelection}`,
} satisfies Record<(typeof Node.Type)["__typename"], string>;
const itemTypes = Object.keys(selections)
  .map((type) => type.replaceAll(/(?<=.)(?=[A-Z])/g, "_").toUpperCase())
  .join(", ");
const nodeSelections = Object.entries(selections)
  .map(([type, selection]) => `... on ${type} { ${selection} }`)
  .join("\n");

const kinds = {
  MergedEvent: "merged",
  ClosedEvent: "closed",
  ReopenedEvent: "reopened",
  ReadyForReviewEvent: "ready-for-review",
  ConvertToDraftEvent: "converted-to-draft",
  LabeledEvent: "labeled",
  UnlabeledEvent: "unlabeled",
  ReviewRequestedEvent: "review-requested",
  ReviewRequestRemovedEvent: "review-request-removed",
  AssignedEvent: "assigned",
  UnassignedEvent: "unassigned",
} as const;
const toReference = (
  subject: typeof Reference.Type,
  crossRepository: boolean,
): TimelineReference => ({
  kind: subject.__typename === "Issue" ? "issue" : "pull-request",
  repository: subject.repository.nameWithOwner,
  number: subject.number,
  title: subject.title,
  url: subject.url,
  crossRepository,
});
const toEvent = (node: typeof Node.Type, prUrl: string): PullRequestTimelineEvent => {
  if (node.__typename === "PullRequestCommit") {
    const commit = node.commit;
    return {
      kind: "commit",
      id: commit.oid,
      sha: commit.oid,
      title: commit.messageHeadline,
      at: commit.committedDate,
      author: commit.author?.user ?? null,
      url: commit.url,
      additions: commit.additions,
      deletions: commit.deletions,
    };
  }
  const base = { id: node.id, at: node.createdAt, author: node.actor, url: prUrl };
  switch (node.__typename) {
    case "HeadRefForcePushedEvent":
      return {
        ...base,
        kind: "force-push",
        beforeSha: node.beforeCommit?.oid ?? null,
        afterSha: node.afterCommit?.oid ?? null,
      };
    case "LabeledEvent":
    case "UnlabeledEvent":
      return { ...base, kind: kinds[node.__typename], label: node.label };
    case "ReviewRequestedEvent":
    case "ReviewRequestRemovedEvent": {
      const reviewer = node.requestedReviewer;
      const avatarUrl = reviewer?.avatarUrl ?? null;
      return {
        ...base,
        kind: kinds[node.__typename],
        reviewer:
          reviewer?.combinedSlug !== undefined
            ? { kind: "team", slug: reviewer.combinedSlug, avatarUrl }
            : reviewer?.login !== undefined
              ? { kind: "user", login: reviewer.login, avatarUrl }
              : null,
      };
    }
    case "AssignedEvent":
    case "UnassignedEvent": {
      const assignee = node.assignee;
      return {
        ...base,
        kind: kinds[node.__typename],
        assignee:
          assignee?.login === undefined
            ? null
            : { login: assignee.login, avatarUrl: assignee.avatarUrl ?? null },
      };
    }
    case "RenamedTitleEvent":
      return {
        ...base,
        kind: "renamed",
        previousTitle: node.previousTitle,
        currentTitle: node.currentTitle,
      };
    case "BaseRefChangedEvent":
      return {
        ...base,
        kind: "base-changed",
        previousBase: node.previousRefName,
        currentBase: node.currentRefName,
      };
    case "CrossReferencedEvent":
      return {
        ...base,
        kind: "cross-referenced",
        source: toReference(node.source, node.isCrossRepository),
      };
    case "MarkedAsDuplicateEvent":
      return {
        ...base,
        kind: "marked-as-duplicate",
        canonical: node.canonical && toReference(node.canonical, node.isCrossRepository),
      };
    default:
      return { ...base, kind: kinds[node.__typename] };
  }
};
type GraphQLResult = {
  readonly data: typeof Response.Type | null;
  readonly errors: ReadonlyArray<GraphQLError>;
};
const quote = Schema.encodeSync(Schema.fromJsonString(Schema.String));
const decodeNode = Schema.decodeUnknownOption(Node);
const decodeTypename = Schema.decodeUnknownOption(Schema.Struct({ __typename: Schema.String }));
const NODES = ["repository", "pullRequest", "timelineItems", "nodes"];
/**
 * GitHub answers an item it won't show, such as a mention from a repository behind
 * SAML SSO, as a null node with an error under `timelineItems.nodes`. GitHub's own
 * page leaves those out too.
 */
const withheld = (error: GraphQLError) => NODES.every((key, index) => error.path?.[index] === key);

export const makeTimelineRead = Effect.gen(function* () {
  const api = yield* GitHubApi;
  return (accountId: AccountId, ref: PullRequestRef) =>
    Effect.gen(function* () {
      const events: PullRequestTimelineEvent[] = [];
      const prUrl = `https://${ref.host}/${ref.owner}/${ref.repo}/pull/${ref.number}`;
      let cursor: string | null = null;
      const cursors = new Set<string>();
      let itemErrors = 0;
      const unreadable: string[] = [];
      for (let pageNumber = 1; ; pageNumber++) {
        const result: GraphQLResult = yield* api.graphqlResult(
          accountId,
          `query PrkitTimeline {
        repository(owner: ${quote(ref.owner)}, name: ${quote(ref.repo)}) {
          pullRequest(number: ${ref.number}) {
            timelineItems(first: 100, after: ${cursor === null ? "null" : quote(cursor)}, itemTypes: [${itemTypes}]) {
              pageInfo { hasNextPage endCursor }
              nodes {
                __typename
                ${nodeSelections}
              }
            }
          }
        }
      }`,
          {},
          Response,
        );
        const { data, errors } = result;
        const failures = errors.filter((error) => !withheld(error));
        if (data === null || failures.length > 0) return yield* queryFailure(accountId, failures);
        itemErrors += errors.length;
        const page = data.repository?.pullRequest?.timelineItems;
        if (!page)
          return yield* new GitHubRequestError({
            accountId,
            reason: "not-found",
            status: 404,
            message: "This pull request is no longer accessible.",
          });
        for (const node of page.nodes) {
          const decoded = decodeNode(node);
          if (Option.isSome(decoded)) events.push(toEvent(decoded.value, prUrl));
          else
            unreadable.push(
              Option.match(decodeTypename(node), {
                onNone: () => "unknown",
                onSome: ({ __typename }) => __typename,
              }),
            );
        }
        if (!page.pageInfo.hasNextPage) break;
        if (
          pageNumber === 30 ||
          page.pageInfo.endCursor === null ||
          cursors.has(page.pageInfo.endCursor)
        ) {
          yield* Effect.logWarning("GitHub timeline pagination could not advance safely").pipe(
            Effect.annotateLogs({ accountId, prUrl, pageNumber, maxPages: 30 }),
          );
          return yield* new GitHubRequestError({
            accountId,
            reason: "rejected",
            status: null,
            message: "GitHub couldn't load the rest of this timeline safely. Open it on GitHub.",
          });
        }
        cursor = page.pageInfo.endCursor;
        cursors.add(cursor);
      }
      if (itemErrors > 0 || unreadable.length > 0)
        yield* Effect.logWarning("GitHub withheld or prkit couldn't read some timeline items").pipe(
          Effect.annotateLogs({ accountId, prUrl, itemErrors, unreadable }),
        );
      const mergedAt = new Set(
        events.filter((event) => event.kind === "merged").map((event) => event.at),
      );
      return {
        events: events.filter((event) => event.kind !== "closed" || !mergedAt.has(event.at)),
      };
    });
});
