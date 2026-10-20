// The fake GitHub's GraphQL answers: inbox searches, fingerprints, file texts, timelines, stacks and auto-merge.
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { seededIssues, seededThreads, seeds } from "./context.ts";
import {
  archived,
  BASE,
  head,
  headRef,
  HISTORY,
  inboxOnly,
  iso,
  LOGIN,
  mergeState,
  nodeId,
  oddShapes,
  OWNER,
  type Pull,
  pulls,
  pullDefaults,
  servedTexts,
  REPO,
  type Reviewer,
  REFUSED_MESSAGE,
  rollup,
  sha,
  STACK,
  stackFields,
  start,
  stats,
  TOOLS_PULL,
  unreadable,
  lost,
  WITHHELD,
} from "./model.ts";
import { STACKS } from "./options.ts";

const GraphQLRequest = Schema.fromJsonString(
  Schema.Struct({
    query: Schema.String,
    variables: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
  }),
);
const decodeRequest = Schema.decodeUnknownOption(GraphQLRequest);

/** Who opened it as a search answers: an odd author as GitHub types it, else the account. */
const authorNode = (pull: Pull) => {
  const author = oddShapes.get(pull.number)?.author;
  if (author === undefined)
    return { login: oddShapes.has(pull.number) ? pull.author : LOGIN, avatarUrl: "" };
  return author.type === "deleted" ? null : { login: author.login, avatarUrl: "" };
};
const labelsNode = (pull: Pull) => {
  if (oddShapes.get(pull.number)?.fieldError === true) return null;
  const labels = oddShapes.get(pull.number)?.labels;
  return labels === undefined ? { nodes: [] } : labels === null ? null : { nodes: labels };
};
const searchNode = (pull: Pull) => ({
  ...stackFields(pull),
  id: nodeId(pull),
  number: pull.number,
  title: oddShapes.get(pull.number)?.malformed === true ? null : pull.title,
  url: `https://github.com/${OWNER}/${REPO}/pull/${pull.number}`,
  state: pull.state,
  isDraft: pull.draft,
  createdAt: iso(pull.createdAt),
  updatedAt: iso(pull.updatedAt),
  headRefName: `feature-${pull.number}`,
  baseRefName: "main",
  additions: pull.size.additions,
  deletions: pull.size.deletions,
  changedFiles: pull.size.files,
  reviewDecision: null,
  author: authorNode(pull),
  repository: { name: REPO, owner: { login: OWNER } },
  labels: labelsNode(pull),
  commits: { nodes: [{ commit: { statusCheckRollup: { state: rollup(pull) } } }] },
});
/**
 * A pull request GitHub refuses comes back as a null node, with an error naming its place; a
 * field GitHub couldn't resolve comes back null, with an error naming the field.
 */
const listNode = (pull: Pull) =>
  oddShapes.get(pull.number)?.refused === true ? null : searchNode(pull);
const refusals = (
  at: ReadonlyArray<string>,
  nodes: ReadonlyArray<{ readonly number: number } | null>,
) =>
  nodes.flatMap((node, index) =>
    node === null
      ? [{ type: "FORBIDDEN", path: [...at, index], message: REFUSED_MESSAGE }]
      : oddShapes.get(node.number)?.fieldError === true
        ? [
            {
              type: "FORBIDDEN",
              path: [...at, index, "labels"],
              message: "Resource not accessible by integration",
            },
          ]
        : [],
  );
const fingerprint = (pull: Pull) => ({
  ...stackFields(pull),
  title: pull.title,
  state: pull.state,
  isDraft: pull.draft,
  updatedAt: iso(pull.updatedAt),
  headRefOid: head(pull),
  baseRefOid: BASE,
  baseRefName: "main",
  reviewDecision: null,
  mergeStateStatus: mergeState(pull),
  comments: { totalCount: pull.comments.length },
  reviews: { totalCount: pull.reviews.length },
});
const FILE_BLOB = { text: "export {};\n", isTruncated: false, isBinary: false, byteSize: 11 };
/** GitHub's search trails a merge: `is:open` still finds the PR, whose node says MERGED. */
const SEARCH_LAG_MS = 15_000;
const search = (numbers: ReadonlyArray<number>) => {
  const nodes = numbers.flatMap((number) => {
    const pull = pulls.get(number);
    if (pull === undefined) return [];
    if (pull.state === "OPEN") return [listNode(pull)];
    if (pull.mergedAt === null || Date.now() - pull.mergedAt >= SEARCH_LAG_MS) return [];
    stats.mergedInSearch++;
    return [listNode(pull)];
  });
  return { issueCount: nodes.length, nodes };
};
const actionRead = (pull: Pull) => ({
  repository: {
    mergeCommitAllowed: true,
    squashMergeAllowed: true,
    rebaseMergeAllowed: true,
    autoMergeAllowed: true,
    isArchived: oddShapes.get(pull.number)?.archived === true,
    viewerPermission: "WRITE",
    viewerDefaultMergeMethod: "MERGE",
    pullRequest: {
      id: nodeId(pull),
      headRefName: headRef(pull),
      baseRefName: "main",
      headRef: null,
      reviewDecision: null,
      mergeStateStatus: mergeState(pull),
      isMergeQueueEnabled: false,
      isCrossRepository: pull.headRepo !== `${OWNER}/${REPO}`,
      viewerCanUpdate: true,
      viewerCanUpdateBranch: pull.state === "OPEN" && pull.behindBy > 0,
      viewerCanClose: true,
      viewerCanReopen: pull.state === "CLOSED",
      viewerCanLabel: false,
      viewerCanAssign: false,
      viewerCanEnableAutoMerge:
        pull.state === "OPEN" && pull.autoMerge === null && mergeState(pull) === "BLOCKED",
      viewerCanDisableAutoMerge: pull.autoMerge !== null,
      autoMergeRequest: pull.autoMerge === null ? null : { mergeMethod: pull.autoMerge },
      baseRef: pull.behindBy > 0 ? { compare: { behindBy: pull.behindBy } } : null,
      mergeTitle: "Merge",
      mergeBody: "",
      squashTitle: "Squash",
      squashBody: "",
      commits: { nodes: [{ commit: { statusCheckRollup: { state: rollup(pull) } } }] },
    },
  },
});

/** GitHub's `PullRequestTimelineItemsItemType` values the fake answers, with their types. */
const ITEM_TYPES: Record<string, string> = {
  PULL_REQUEST_COMMIT: "PullRequestCommit",
  HEAD_REF_FORCE_PUSHED_EVENT: "HeadRefForcePushedEvent",
  MERGED_EVENT: "MergedEvent",
  CLOSED_EVENT: "ClosedEvent",
  REOPENED_EVENT: "ReopenedEvent",
  READY_FOR_REVIEW_EVENT: "ReadyForReviewEvent",
  CONVERT_TO_DRAFT_EVENT: "ConvertToDraftEvent",
  LABELED_EVENT: "LabeledEvent",
  UNLABELED_EVENT: "UnlabeledEvent",
  REVIEW_REQUESTED_EVENT: "ReviewRequestedEvent",
  REVIEW_REQUEST_REMOVED_EVENT: "ReviewRequestRemovedEvent",
  ASSIGNED_EVENT: "AssignedEvent",
  UNASSIGNED_EVENT: "UnassignedEvent",
  RENAMED_TITLE_EVENT: "RenamedTitleEvent",
  BASE_REF_CHANGED_EVENT: "BaseRefChangedEvent",
  CROSS_REFERENCED_EVENT: "CrossReferencedEvent",
  MARKED_AS_DUPLICATE_EVENT: "MarkedAsDuplicateEvent",
};
/** The types each union field of the timeline can hold, from GitHub's schema. */
const FIELD_TYPES: Record<string, ReadonlyArray<string>> = {
  nodes: Object.values(ITEM_TYPES),
  assignee: ["Bot", "Mannequin", "Organization", "User"],
  requestedReviewer: ["Bot", "EnterpriseTeam", "Mannequin", "Team", "User"],
  source: ["Issue", "PullRequest"],
  canonical: ["Issue", "PullRequest"],
};
/** The types a fragment's type stands for; none when GitHub has no such type. */
const fragmentTypes = (type: string) =>
  type === "Actor"
    ? ["Bot", "EnterpriseUserAccount", "Mannequin", "Organization", "User"]
    : Object.values(FIELD_TYPES).some((types) => types.includes(type))
      ? [type]
      : [];

/** What a query selects: the fields it names, and what it selects on each type. */
interface Selection {
  readonly fields: Map<string, Selection | null>;
  readonly on: Map<string, Selection>;
}
/** The selection set opening at `tokens[open]`, and the index after it closes. */
const parseSelection = (
  tokens: ReadonlyArray<string>,
  open: number,
  parent: string,
  errors: Array<string>,
): [Selection, number] => {
  const selection: Selection = { fields: new Map(), on: new Map() };
  let index = open + 1;
  while (index < tokens.length && tokens[index] !== "}") {
    const token = tokens[index] ?? "";
    if (token === "...") {
      const type = tokens[index + 2] ?? "";
      const types = fragmentTypes(type);
      if (types.length === 0)
        errors.push(`No such type ${type}, so it can't be a fragment condition`);
      else if (!types.some((member) => FIELD_TYPES[parent]?.includes(member)))
        errors.push(`Fragment on ${type} can't be spread inside ${parent}`);
      const [inner, next] = parseSelection(tokens, index + 3, parent, errors);
      selection.on.set(type, inner);
      index = next;
    } else if (tokens[index + 1] === "{") {
      const [inner, next] = parseSelection(tokens, index + 1, token, errors);
      selection.fields.set(token, inner);
      index = next;
    } else {
      selection.fields.set(token, null);
      index++;
    }
  }
  return [selection, index + 1];
};
/** `value` with only what `selection` asks for, the way GitHub answers. */
const project = (value: Schema.Json, selection: Selection | null): Schema.Json => {
  if (selection === null || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item: Schema.Json) => project(item, selection));
  const fields = new Map(Object.entries(value));
  const type = String(fields.get("__typename"));
  const picked: Record<string, Schema.Json> = {};
  const pick = (wanted: Selection) => {
    for (const [name, inner] of wanted.fields) {
      const field = fields.get(name);
      if (field !== undefined) picked[name] = project(field, inner);
    }
    for (const [fragment, inner] of wanted.on)
      if (fragmentTypes(fragment).includes(type)) pick(inner);
  };
  pick(selection);
  return picked;
};

const timeline = (pull: Pull, query: string) => {
  const errors: Array<string> = [];
  const itemTypes = (/itemTypes: \[([^\]]*)\]/.exec(query)?.[1] ?? "")
    .split(",")
    .map((type) => type.trim())
    .filter((type) => type !== "");
  for (const type of itemTypes)
    if (ITEM_TYPES[type] === undefined)
      errors.push(`Argument 'itemTypes' on Field 'timelineItems' has an invalid value (${type}).`);
  const tokens = [...query.replaceAll(/\([^()]*\)/g, " ").matchAll(/\.\.\.|[{}]|\w+/g)].map(
    (match) => match[0],
  );
  const [selection] = parseSelection(
    tokens,
    tokens.indexOf("timelineItems") + 1,
    "timelineItems",
    errors,
  );
  if (errors.length > 0) return { data: null, errors: errors.map((message) => ({ message })) };
  const wanted = new Set(itemTypes.map((type) => ITEM_TYPES[type]));
  const items = [
    ...pull.heads.map((commit) => ({
      __typename: "PullRequestCommit",
      commit: {
        oid: commit.sha,
        messageHeadline: commit.message,
        committedDate: iso(commit.at),
        additions: 1,
        deletions: 0,
        url: `https://github.com/${OWNER}/${REPO}/commit/${commit.sha}`,
        author: { user: { login: LOGIN, avatarUrl: "" } },
      },
    })),
    ...(pull.number === 8 ? HISTORY : []),
  ].filter((item) => wanted.has(item.__typename));
  const withheld = items.flatMap((item, index) =>
    "source" in item && item.source === WITHHELD ? [index] : [],
  );
  const timelineItems = project(
    {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: items.map((item, index) => (withheld.includes(index) ? null : item)),
    },
    selection,
  );
  return {
    data: { repository: { pullRequest: { timelineItems } } },
    ...(withheld.length === 0
      ? {}
      : {
          errors: withheld.map((index) => ({
            type: "FORBIDDEN",
            path: ["repository", "pullRequest", "timelineItems", "nodes", index, "source"],
            message: REFUSED_MESSAGE,
          })),
        }),
  };
};

const stackLayers = () => ({
  repository: {
    pullRequest: {
      stack: {
        number: 900,
        baseRefName: "main",
        entries: {
          nodes: STACK.flatMap((number, index) => {
            const pull = pulls.get(number);
            return pull === undefined
              ? []
              : [
                  {
                    position: index + 1,
                    pullRequest: {
                      number,
                      title: pull.title,
                      state: "OPEN",
                      isDraft: false,
                      headRefName: `feature-${number}`,
                      baseRefName: index === 0 ? "main" : `feature-${STACK[index - 1] ?? 1}`,
                      additions: pull.size.additions,
                      deletions: pull.size.deletions,
                    },
                  },
                ];
          }),
        },
      },
    },
  },
});

const toolsNode = () => ({
  ...searchNode({
    ...TOOLS_PULL,
    heads: [{ sha: sha("tools-1"), at: start, message: "Start tools" }],
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
  }),
  ...(STACKS ? { stack: null, stackEntry: null } : {}),
  url: `https://github.com/${OWNER}/tools/pull/1`,
  author: { login: TOOLS_PULL.author, avatarUrl: "" },
  repository: { name: "tools", owner: { login: OWNER } },
});

const decodeIds = Schema.decodeUnknownOption(Schema.Array(Schema.String));
const reviewerNode = (reviewer: Reviewer) =>
  reviewer.kind === "user"
    ? { __typename: "User", login: reviewer.login }
    : { __typename: "Team", combinedSlug: reviewer.slug };
const PAGE = 20;
const reviewWaits = (ids: ReadonlyArray<string>) => {
  const errors: Array<Schema.Json> = [];
  const nodes = ids.map((id, index) => {
    const pull = [...pulls.values()].find((candidate) => nodeId(candidate) === id);
    if (pull === undefined || unreadable.has(pull.number)) {
      errors.push({
        type: pull === undefined ? "NOT_FOUND" : "FORBIDDEN",
        path: ["nodes", index],
        message:
          pull === undefined
            ? `Could not resolve to a node with the global id of '${id}'`
            : REFUSED_MESSAGE,
      });
      return null;
    }
    const events = pull.reviewEvents.toSorted((left, right) => left.at - right.at);
    return {
      id,
      reviewRequests: {
        pageInfo: { hasNextPage: pull.requested.length > PAGE },
        nodes: pull.requested
          .slice(0, PAGE)
          .map((reviewer) => ({ requestedReviewer: reviewerNode(reviewer) })),
      },
      timelineItems: {
        pageInfo: { hasPreviousPage: events.length > PAGE },
        nodes: events.slice(-PAGE).map((event) =>
          event.kind === "ready"
            ? { __typename: "ReadyForReviewEvent", createdAt: iso(event.at) }
            : {
                __typename: "ReviewRequestedEvent",
                createdAt: iso(event.at),
                requestedReviewer: reviewerNode(event.reviewer),
              },
        ),
      },
    };
  });
  return {
    kind: "graphql:review-waits",
    cost: 1,
    data: { nodes },
    ...(errors.length === 0 ? {} : { errors }),
  };
};

const decodeMutationTarget = Schema.decodeUnknownOption(
  Schema.Union([
    Schema.Struct({
      input: Schema.Struct({
        pullRequestId: Schema.String,
        mergeMethod: Schema.optionalKey(Schema.Literals(["MERGE", "SQUASH", "REBASE"])),
      }),
    }),
    Schema.Struct({ id: Schema.String }),
  ]),
);

/** The auto-merge mutations, answered like GitHub: enabling needs a PR that is blocked. */
const mutation = (
  query: string,
  variables: Record<string, Schema.Json>,
): { kind: string; cost: number; data: Schema.Json; errors?: Schema.Json } => {
  const target = Option.getOrNull(decodeMutationTarget(variables));
  const id =
    target === null ? undefined : "input" in target ? target.input.pullRequestId : target.id;
  const method = target !== null && "input" in target ? target.input.mergeMethod : undefined;
  const pull = [...pulls.values()].find((candidate) => nodeId(candidate) === id);
  const refused = (message: string) => ({
    kind: "graphql:mutation-refused",
    cost: 1,
    data: null,
    errors: [{ type: "UNPROCESSABLE", message }],
  });
  if (query.includes("enablePullRequestAutoMerge")) {
    if (pull === undefined) return refused("Could not resolve to a node.");
    if (mergeState(pull) !== "BLOCKED")
      return refused(`Pull request is in ${mergeState(pull).toLowerCase()} status`);
    if (method === undefined) return refused("Expected a merge method.");
    pull.autoMerge = method;
    pull.updatedAt = Date.now();
    return {
      kind: "graphql:enable-auto-merge",
      cost: 1,
      data: { enablePullRequestAutoMerge: { clientMutationId: null } },
    };
  }
  if (query.includes("disablePullRequestAutoMerge")) {
    if (pull === undefined || pull.autoMerge === null)
      return refused("Auto-merge is not enabled for this pull request.");
    pull.autoMerge = null;
    pull.updatedAt = Date.now();
    return {
      kind: "graphql:disable-auto-merge",
      cost: 1,
      data: { disablePullRequestAutoMerge: { clientMutationId: null } },
    };
  }
  return refused("The fake GitHub doesn't answer this mutation.");
};

/** The GraphQL point cost GitHub would charge, roughly: the inbox's three searches cost 6. */
export const graphql = (
  body: string,
  login: string,
): { kind: string; cost: number; data: Schema.Json; errors?: Schema.Json } => {
  const decoded = decodeRequest(body);
  if (Option.isNone(decoded))
    return {
      kind: "graphql:unsupported",
      cost: 0,
      data: null,
      errors: [{ type: "BAD_USER_INPUT", message: "The fake expects one GraphQL request." }],
    };
  const query = decoded.value.query;
  const variables = decoded.value.variables ?? {};
  const pullFrom = (value: Schema.Json | undefined) => pulls.get(Number(value));
  if (query.includes("PrkitPushAccess")) {
    const pull = pullFrom(variables["number"]);
    return {
      kind: "graphql:push-access",
      cost: 1,
      data: {
        viewer: { login: LOGIN },
        repository: {
          viewerPermission: "WRITE",
          pullRequest:
            pull === undefined
              ? null
              : {
                  state: pull.state,
                  headRefName: `feature-${pull.number}`,
                  isCrossRepository: pull.headRepo !== `${OWNER}/${REPO}`,
                  maintainerCanModify: true,
                  headRepository:
                    oddShapes.get(pull.number)?.deletedFork === true
                      ? null
                      : {
                          nameWithOwner: pull.headRepo,
                          isArchived: false,
                          viewerPermission: "WRITE",
                        },
                },
        },
      },
    };
  }
  if (query.includes("PrkitAssignableUsers"))
    return {
      kind: "graphql:assignable-users",
      cost: 1,
      data: {
        repository: {
          assignableUsers: {
            nodes: [{ login: LOGIN, name: "Fixture reviewer", avatarUrl: "" }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    };
  if (!STACKS && query.includes("stackEntry"))
    return {
      kind: "graphql:no-stacks",
      cost: 1,
      data: null,
      errors: [
        {
          message: "Field 'stack' doesn't exist on type 'PullRequest'",
          extensions: { code: "undefinedField", typeName: "PullRequest", fieldName: "stack" },
        },
      ],
    };
  if (query.includes("PrkitRepositories"))
    return {
      kind: "graphql:repositories",
      cost: 1,
      data: {
        viewer: {
          repositories: {
            totalCount: 3,
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              { name: "attic", isPrivate: false },
              { name: REPO, isPrivate: false },
              { name: "tools", isPrivate: true },
            ].map(({ name, isPrivate }) => ({
              name,
              isPrivate,
              isArchived: archived.has(name),
              owner: { login: OWNER },
            })),
          },
        },
      },
    };
  if (query.includes("PrkitRepositoryPulls")) {
    const name = String(variables["name"] ?? "");
    const nodes =
      name === REPO
        ? [...pulls.values()]
            .filter((pull) => pull.number <= 6 || oddShapes.has(pull.number))
            .map(listNode)
        : name === "tools"
          ? [toolsNode()]
          : null;
    const errors = refusals(["repository", "pullRequests", "nodes"], nodes ?? []);
    return {
      kind: "graphql:repository-pulls",
      cost: 1,
      data: {
        repository: nodes === null ? null : { pullRequests: { totalCount: nodes.length, nodes } },
      },
      ...(errors.length === 0 ? {} : { errors }),
    };
  }
  if (query.includes("PrkitStack"))
    return { kind: "graphql:stack", cost: 1, data: STACKS ? stackLayers() : { repository: null } };
  if (query.includes("PrkitReviewWaits"))
    return reviewWaits(Option.getOrElse(decodeIds(variables["ids"]), () => []));
  if (query.includes("PrkitInbox")) {
    const sees = (number: number) => inboxOnly.get(login)?.has(number) ?? true;
    const data = {
      reviewRequested: search(
        [1, 2, 3, 4, 5, 6, 9].filter(
          (number) => sees(number) && (pulls.get(number)?.requested.length ?? 0) > 0,
        ),
      ),
      authored: search([4, 5, 6].filter(sees)),
      involved: search([...oddShapes.keys()].filter(sees)),
    };
    const errors = Object.entries(data).flatMap(([alias, found]) =>
      refusals([alias, "nodes"], found.nodes),
    );
    return {
      kind: "graphql:inbox",
      cost: 6,
      data,
      ...(errors.length === 0 ? {} : { errors }),
    };
  }
  if (query.includes("PrkitTexts")) {
    // A PR's head has the texts `texts` seeded for it, and every other path is the one-line
    // file REST contents answers.
    const byHead = new Map([...pulls.values()].map((pull) => [head(pull), pull.number]));
    const blobs: Record<string, typeof FILE_BLOB | null> = {};
    for (const match of query.matchAll(/(f\d+): object\(expression: \$(e\d+)\)/g)) {
      const [, alias = "", variable = ""] = match;
      const expression = String(variables[variable] ?? "");
      const split = expression.indexOf(":");
      const number = byHead.get(expression.slice(0, split));
      const seeded =
        number === undefined
          ? undefined
          : servedTexts.get(number)?.get(expression.slice(split + 1));
      blobs[alias] =
        number === undefined
          ? null
          : seeded === undefined
            ? FILE_BLOB
            : {
                text: seeded,
                isTruncated: false,
                isBinary: false,
                byteSize: Buffer.byteLength(seeded),
              };
    }
    const known = variables["owner"] === OWNER && variables["name"] === REPO;
    return { kind: "graphql:texts", cost: 1, data: { repository: known ? blobs : null } };
  }
  if (query.includes("PrkitWatch")) {
    const data: Record<string, { pullRequest: ReturnType<typeof fingerprint> | null } | null> = {};
    const errors: Array<Schema.Json> = [];
    for (const match of query.matchAll(/(p\d+): repository/g)) {
      const alias = match[1] ?? "";
      const index = alias.slice(1);
      const pull = variables[`r${index}`] === REPO ? pullFrom(variables[`n${index}`]) : undefined;
      if (pull !== undefined && lost.has(pull.number)) {
        data[alias] = null;
        errors.push({
          type: "NOT_FOUND",
          path: [alias],
          message: `Could not resolve to a Repository with the name '${OWNER}/${REPO}'.`,
        });
      } else data[alias] = { pullRequest: pull === undefined ? null : fingerprint(pull) };
    }
    return {
      kind: "graphql:fingerprint",
      cost: 1,
      data,
      ...(errors.length === 0 ? {} : { errors }),
    };
  }
  if (query.includes("PrkitTimeline")) {
    const pull = pulls.get(Number(/pullRequest\(number: (\d+)\)/.exec(query)?.[1]));
    if (pull === undefined)
      return { kind: "graphql:timeline", cost: 1, data: { repository: null } };
    const answer = timeline(pull, query);
    return {
      kind: answer.data === null ? "graphql:invalid" : "graphql:timeline",
      cost: 1,
      ...answer,
    };
  }
  if (query.startsWith("mutation")) return mutation(query, variables);
  if (query.includes("pullRequests(headRefName:")) {
    const branch = variables["branch"];
    return {
      kind: "graphql:pulls-by-head",
      cost: 1,
      data: {
        repository: {
          pullRequests: {
            nodes: [...pulls.values()]
              .filter((pull) => pull.state === "OPEN" && headRef(pull) === branch)
              .map((pull) => ({
                number: pull.number,
                headRefOid: head(pull),
                headRepository: { nameWithOwner: pull.headRepo },
              })),
            pageInfo: { hasNextPage: false },
          },
        },
      },
    };
  }
  const pull = pullFrom(variables["number"]);
  const seed = pull === undefined ? undefined : seeds.get(pull.number);
  if (query.includes("PrkitClosingIssues"))
    return {
      kind: "graphql:closing-issues",
      cost: 1,
      data: {
        repository: {
          pullRequest:
            pull === undefined
              ? null
              : {
                  closingIssuesReferences:
                    seed === undefined ? { totalCount: 0, nodes: [] } : seededIssues(seed),
                },
        },
      },
    };
  if (query.includes("reviewThreads"))
    return {
      kind: "graphql:threads",
      cost: 1,
      data: {
        repository: {
          pullRequest:
            pull === undefined
              ? null
              : {
                  headRefOid: head(pull),
                  reviewThreads: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: seed === undefined ? [] : seededThreads(pull, seed),
                  },
                },
        },
      },
    };
  if (query.includes("viewerMergeHeadlineText") && pull !== undefined)
    return { kind: "graphql:actions", cost: 1, data: actionRead(pull) };
  return { kind: "graphql:other", cost: 1, data: null };
};
