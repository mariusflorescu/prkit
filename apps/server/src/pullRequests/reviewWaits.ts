import {
  type Account,
  type AccountId,
  type InboxEntry,
  loginOf,
  type ReviewWait,
} from "@prkit/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { GitHubApi, type GraphQLError, queryFailure } from "../github/GitHubApi.ts";
import type { CachedInboxEntry } from "./inboxEntries.ts";
import { GITHUB_PAGE_LIMIT } from "./inboxQuery.ts";
import { withDeadline } from "./readDeadline.ts";

const reviewer = `__typename ... on User { login } ... on Team { combinedSlug }`;
const waitsQuery = `query PrkitReviewWaits($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on PullRequest {
      id
      reviewRequests(first: 20) {
        pageInfo { hasNextPage }
        nodes { requestedReviewer { ${reviewer} } }
      }
      timelineItems(last: 20, itemTypes: [REVIEW_REQUESTED_EVENT, READY_FOR_REVIEW_EVENT]) {
        pageInfo { hasPreviousPage }
        nodes {
          __typename
          ... on ReviewRequestedEvent { createdAt requestedReviewer { ${reviewer} } }
          ... on ReadyForReviewEvent { createdAt }
        }
      }
    }
  }
}`;

const WaitsResponse = Schema.Struct({ nodes: Schema.Array(Schema.Json) });

/**
 * GitHub's reviewer is a union that may grow (bots, mannequins, enterprise teams); a member
 * prkit doesn't select anything from has neither field and reads as nobody.
 */
const ReviewerNode = Schema.Struct({
  login: Schema.optionalKey(Schema.String),
  combinedSlug: Schema.optionalKey(Schema.String),
});
const WaitNode = Schema.Struct({
  id: Schema.String,
  reviewRequests: Schema.Struct({
    pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean }),
    nodes: Schema.Array(
      Schema.NullOr(Schema.Struct({ requestedReviewer: Schema.NullOr(ReviewerNode) })),
    ),
  }),
  timelineItems: Schema.Struct({
    pageInfo: Schema.Struct({ hasPreviousPage: Schema.Boolean }),
    nodes: Schema.Array(
      Schema.Union([
        Schema.Struct({
          __typename: Schema.Literal("ReviewRequestedEvent"),
          createdAt: Schema.String,
          requestedReviewer: Schema.NullOr(ReviewerNode),
        }),
        Schema.Struct({
          __typename: Schema.Literal("ReadyForReviewEvent"),
          createdAt: Schema.String,
        }),
      ]),
    ),
  }),
});
const decodeNode = Schema.decodeUnknownOption(WaitNode);

const Reviewer = Schema.Union([
  Schema.TaggedStruct("user", { login: Schema.String }),
  Schema.TaggedStruct("team", { slug: Schema.String }),
]);
type Reviewer = typeof Reviewer.Type;
const reviewerOf = (node: typeof ReviewerNode.Type | null): Reviewer | null =>
  node === null
    ? null
    : node.login !== undefined
      ? { _tag: "user", login: node.login }
      : node.combinedSlug !== undefined
        ? { _tag: "team", slug: node.combinedSlug }
        : null;

const ReadFacts = Schema.TaggedStruct("read", {
  pending: Schema.Array(Reviewer),
  pendingTruncated: Schema.Boolean,
  events: Schema.Array(
    Schema.Union([
      Schema.TaggedStruct("requested", { at: Schema.String, reviewer: Schema.NullOr(Reviewer) }),
      Schema.TaggedStruct("ready", { at: Schema.String }),
    ]),
  ),
  olderEvents: Schema.Boolean,
});
type ReadFacts = typeof ReadFacts.Type;

/** What GitHub said about one pull request's reviews; `unreadable` when it gave nothing prkit can use. */
const WaitFacts = Schema.Union([ReadFacts, Schema.TaggedStruct("unreadable", {})]);

/** The facts for an account's review requests, by pull request node id, kept with its inbox. */
export const WaitsByNode = Schema.Record(Schema.String, WaitFacts);
export type WaitsByNode = typeof WaitsByNode.Type;

const factsOf = (node: typeof WaitNode.Type): ReadFacts => ({
  _tag: "read",
  pending: node.reviewRequests.nodes.flatMap((request) => {
    const found = request === null ? null : reviewerOf(request.requestedReviewer);
    return found === null ? [] : [found];
  }),
  pendingTruncated: node.reviewRequests.pageInfo.hasNextPage,
  events: node.timelineItems.nodes
    .map((event) =>
      event.__typename === "ReadyForReviewEvent"
        ? ({ _tag: "ready", at: event.createdAt } as const)
        : ({
            _tag: "requested",
            at: event.createdAt,
            reviewer: reviewerOf(event.requestedReviewer),
          } as const),
    )
    .toSorted((left, right) => Date.parse(left.at) - Date.parse(right.at)),
  olderEvents: node.timelineItems.pageInfo.hasPreviousPage,
});

/** Every id gets an answer, joined by id and never by position: a missing or undecodable node is `unreadable`. */
const waitsOf = (
  accountId: AccountId,
  ids: ReadonlyArray<string>,
  response: typeof WaitsResponse.Type,
) =>
  Effect.gen(function* () {
    const found = new Map<string, ReadFacts>();
    let undecodable = 0;
    for (const raw of response.nodes) {
      if (raw === null) continue;
      const node = Option.getOrNull(decodeNode(raw));
      if (node === null) undecodable++;
      else found.set(node.id, factsOf(node));
    }
    if (undecodable > 0)
      yield* Effect.logWarning("GitHub's review history didn't match what prkit reads").pipe(
        Effect.annotateLogs({ accountId, nodes: undecodable }),
      );
    return Object.fromEntries(
      ids.map((id) => [id, found.get(id) ?? ({ _tag: "unreadable" } as const)]),
    );
  });

/** Errors under `nodes` belong to one pull request (SAML, no access, gone). */
const unscopedErrors = (errors: ReadonlyArray<GraphQLError>) =>
  errors.filter((error) => error.path?.[0] !== "nodes");

const waitIds = (entries: ReadonlyArray<CachedInboxEntry>) =>
  entries
    .filter((entry) => entry.reasons.includes("review-requested"))
    .map((entry) => entry.nodeId)
    .slice(0, GITHUB_PAGE_LIMIT);

const WAITS_DEADLINE = {
  name: "Review waits read",
  ms: 10_000,
  message: "GitHub took too long to say when reviews were requested.",
};

/**
 * The facts for the review requests among `entries`, read now. A failed read gives the
 * `previous` facts of the same pull requests, else none, so it never fails the inbox read
 * it belongs to.
 */
export const makeReviewWaits = Effect.gen(function* () {
  const api = yield* GitHubApi;
  const read = (
    account: Account,
    entries: ReadonlyArray<CachedInboxEntry>,
    previous: WaitsByNode,
  ) => {
    const ids = waitIds(entries);
    if (ids.length === 0) return Effect.succeed<WaitsByNode>({});
    return api.graphqlResult(account.id, waitsQuery, { ids }, WaitsResponse).pipe(
      Effect.flatMap(({ data, errors }) =>
        data === null || unscopedErrors(errors).length > 0
          ? Effect.fail(queryFailure(account.id, errors))
          : waitsOf(account.id, ids, data),
      ),
      withDeadline(account.id, WAITS_DEADLINE),
      Effect.catchTag("GitHubRequestError", (error) =>
        Effect.logWarning("Review waits read failed; keeping the last facts").pipe(
          Effect.annotateLogs({ accountId: account.id, reason: error.reason }),
          Effect.as(
            Object.fromEntries(
              ids.flatMap((id) => {
                const facts = previous[id];
                return facts === undefined ? [] : [[id, facts]];
              }),
            ),
          ),
        ),
      ),
    );
  };
  return { read };
});

const sameName = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

const NO_HISTORY: ReviewWait = { _tag: "unknown", reason: "no-history" };
type Waiting = Extract<ReviewWait, { _tag: "waiting" }>;

const requestsOf = (facts: ReadFacts) =>
  facts.events.flatMap((event) => (event._tag === "requested" ? [event] : []));

/** The request is older than the events read: the wait is at least as long as the oldest of them says. */
const olderThanRead = (facts: ReadFacts, via: Waiting["via"]): ReviewWait => {
  const oldest = facts.events.at(0)?.at;
  return oldest === undefined || !facts.olderEvents
    ? NO_HISTORY
    : { _tag: "waiting", since: oldest, cause: "requested", via, atLeast: true };
};

/** The latest request that names `login`, which GitHub does say for a direct request. */
const forYou = (facts: ReadFacts, login: string): ReviewWait => {
  const named = requestsOf(facts).filter(
    (event) => event.reviewer?._tag === "user" && sameName(event.reviewer.login, login),
  );
  const latest = named.at(-1);
  return latest === undefined
    ? olderThanRead(facts, { _tag: "you" })
    : {
        _tag: "waiting",
        since: latest.at,
        cause: named.length > 1 ? "requested-again" : "requested",
        via: { _tag: "you" },
        atLeast: false,
      };
};

/**
 * GitHub says a search matched you through a team, never which one. One pending team is the
 * one that did, so its latest request is exact; with several, the latest of them is a lower bound.
 */
const forTeams = (facts: ReadFacts): ReviewWait => {
  const teams = facts.pending.flatMap((who) => (who._tag === "team" ? [who.slug] : []));
  const [first, ...rest] = teams;
  if (first === undefined) return NO_HISTORY;
  const via = { _tag: "teams", teams: [first, ...rest] } as const;
  const requests = requestsOf(facts);
  const times = teams.flatMap((team) => {
    const at = requests.findLast(
      (event) => event.reviewer?._tag === "team" && sameName(event.reviewer.slug, team),
    )?.at;
    return at === undefined ? [] : [at];
  });
  const since = times.toSorted((left, right) => Date.parse(right) - Date.parse(left)).at(0);
  return since === undefined
    ? olderThanRead(facts, via)
    : { _tag: "waiting", since, cause: "requested", via, atLeast: teams.length > 1 };
};

/** A request made while the pull request was a draft waits from the moment it was marked ready. */
const readyAfter = (facts: ReadFacts, start: ReviewWait): ReviewWait => {
  const ready = facts.events.findLast((event) => event._tag === "ready")?.at;
  return start._tag === "waiting" &&
    ready !== undefined &&
    Date.parse(ready) > Date.parse(start.since)
    ? { ...start, since: ready, cause: "ready", atLeast: false }
    : start;
};

/** Where `login`'s review request started waiting; the only place the rule lives. */
const reviewWaitOf = (login: string, isDraft: boolean, found: WaitLookup): ReviewWait => {
  if (isDraft) return { _tag: "draft" };
  switch (found._tag) {
    case "not-read":
      return { _tag: "unknown", reason: "not-read" };
    case "unreadable":
      return { _tag: "unknown", reason: "unreadable" };
    case "read": {
      const asked = found.pending.some((who) => who._tag === "user" && sameName(who.login, login));
      const start = asked
        ? forYou(found, login)
        : found.pendingTruncated
          ? NO_HISTORY
          : forTeams(found);
      return readyAfter(found, start);
    }
  }
};

type WaitLookup = typeof WaitFacts.Type | { readonly _tag: "not-read" };
const NOT_READ: WaitLookup = { _tag: "not-read" };

/** The wire entries: each review request carries its wait, every other entry `null`. */
export const withWaits = (
  accountId: AccountId,
  entries: ReadonlyArray<CachedInboxEntry>,
  waits: WaitsByNode,
): ReadonlyArray<InboxEntry> => {
  const login = loginOf(accountId);
  return entries.map(({ nodeId, ...entry }) => ({
    ...entry,
    wait: entry.reasons.includes("review-requested")
      ? reviewWaitOf(login, entry.isDraft, waits[nodeId] ?? NOT_READ)
      : null,
  }));
};
