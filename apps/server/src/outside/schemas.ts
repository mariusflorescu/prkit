import {
  AccountId,
  AgentInstanceId,
  AgentProviderKind,
  DEFAULT_INBOX_SORT,
  FixerTurnId,
  GitHubLimit,
  GuidanceEdit,
  GuideItemId,
  GuideOverride,
  PullRequestDetail,
  GitHubProblem,
  InboxReason,
  InboxResult,
  InboxSort,
  ModelOptionSelection,
  NormalizedGuide,
  OutsideAccess,
  PullRequestKey,
  PullRequestSize,
  PullRequestSummary,
  ReviewCommentId,
  ReviewWait,
} from "@prkit/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ResponseFields } from "./responseSchemas.ts";
import { PageFields, PageInfo } from "./pageSchemas.ts";

/** What every outside tool fails with: a code a client can act on and a plain sentence. */
export class OutsideToolFailure extends Schema.TaggedError<OutsideToolFailure>()(
  "OutsideToolFailure",
  {
    code: Schema.Literals([
      "invalid",
      "not-found",
      "account-needed",
      "not-allowed",
      "not-ready",
      "conflict",
      "github",
      "failed",
    ]),
    message: Schema.String,
  },
) {}

const describe = <S extends Schema.Top>(schema: S, description: string) =>
  schema.annotate({ description });

/** A pull request by URL or by host, owner, repo and number, and optionally the account to read it through. */
/**
 * Path-safe names: a login or organization (managed users carry `_`, as in `mona_acme`) and a
 * repository name. Never empty, never a slash, never "." or "..".
 */
export const OWNER_NAME = /^[A-Za-z0-9_-]{1,100}$/;
export const REPO_NAME = /^(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/;
export const HOST_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(?::\d{1,5})?$/;

export const TargetFields = {
  ...ResponseFields,
  url: Schema.optionalKey(
    describe(
      Schema.String,
      "The pull request's URL, such as https://github.com/acme/widgets/pull/42.",
    ),
  ),
  host: Schema.optionalKey(
    describe(
      Schema.String.check(Schema.isPattern(HOST_NAME)),
      "GitHub host; github.com when omitted.",
    ),
  ),
  owner: Schema.optionalKey(Schema.String.check(Schema.isPattern(OWNER_NAME))),
  repo: Schema.optionalKey(Schema.String.check(Schema.isPattern(REPO_NAME))),
  number: Schema.optionalKey(Schema.Int),
  accountId: Schema.optionalKey(
    describe(
      AccountId,
      "The GitHub account to read it through, as prkit_status lists it (github.com/octocat). Needed only when prkit asks for it.",
    ),
  ),
};
export const TargetInput = Schema.Struct(TargetFields);
export type TargetInput = typeof TargetInput.Type;

export const Target = Schema.Struct({
  key: PullRequestKey,
  accountId: AccountId,
  url: Schema.String,
});

// prkit_status
export const StatusResult = Schema.Struct({
  version: Schema.String,
  access: OutsideAccess,
  accounts: Schema.Array(
    Schema.Struct({
      accountId: AccountId,
      login: Schema.String,
      host: Schema.String,
      ready: Schema.Boolean,
      problem: Schema.NullOr(Schema.String),
      budget: Schema.Array(GitHubLimit),
    }),
  ),
  agents: Schema.Array(
    Schema.Struct({
      instance: AgentInstanceId,
      label: Schema.String,
      kind: AgentProviderKind,
      enabled: Schema.Boolean,
      isDefault: Schema.Boolean,
      ready: Schema.Boolean,
      problem: Schema.NullOr(Schema.String),
      models: Schema.Array(Schema.Struct({ slug: Schema.String, name: Schema.String })),
    }),
  ),
  work: Schema.Struct({
    guidesRunning: Schema.Int,
    guidesQueued: Schema.Int,
    fixesRunning: Schema.Int,
    fixesQueued: Schema.Int,
    fixesWaitingForPush: Schema.Int,
  }),
});
export type StatusResult = typeof StatusResult.Type;

// list_inbox
export const InboxInput = Schema.Struct({
  ...PageFields,
  reason: Schema.optionalKey(InboxReason),
  repository: Schema.optionalKey(
    Schema.Struct({
      host: Schema.String.check(Schema.isPattern(HOST_NAME)),
      owner: Schema.String.check(Schema.isPattern(OWNER_NAME)),
      name: Schema.String.check(Schema.isPattern(REPO_NAME)),
    }),
  ),
  state: Schema.optionalKey(PullRequestSummary.fields.state),
  draft: Schema.optionalKey(Schema.Boolean),
  checks: Schema.optionalKey(Schema.Literals(["passing", "failing", "pending", "none"])),
  search: Schema.optionalKey(Schema.String),
  stacks: Schema.optionalKey(Schema.Literals(["all", "stacked", "unstacked"])),
  sort: InboxSort.pipe(Schema.withDecodingDefaultKey(Effect.succeed(DEFAULT_INBOX_SORT))),
  refresh: Schema.optionalKey(
    describe(
      Schema.Boolean,
      "Read GitHub now instead of prkit's cache. Spends the accounts' GitHub budget; use it only when asked.",
    ),
  ),
  accountId: Schema.optionalKey(describe(AccountId, "Only this account's pull requests.")),
});
export const InboxPullRequest = Schema.Struct({
  key: PullRequestKey,
  url: Schema.String,
  title: Schema.String,
  author: Schema.NullOr(Schema.String),
  state: PullRequestSummary.fields.state,
  isDraft: Schema.Boolean,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  size: PullRequestSize,
  wait: Schema.NullOr(ReviewWait),
  checks: PullRequestSummary.fields.checks,
  reviewDecision: PullRequestSummary.fields.reviewDecision,
  reasons: Schema.Array(InboxReason),
  stack: Schema.NullOr(Schema.String),
  guide: Schema.NullOr(Schema.String),
});
export const InboxListResult = Schema.Struct({
  ...PageInfo,
  githubTruncated: InboxResult.fields.truncated,
  accounts: Schema.Array(
    Schema.Struct({
      accountId: AccountId,
      fetchedAt: Schema.NullOr(Schema.String),
      problem: Schema.NullOr(GitHubProblem),
      sections: Schema.Array(
        Schema.Struct({ reason: InboxReason, pullRequests: Schema.Array(InboxPullRequest) }),
      ),
    }),
  ),
});
export type InboxListResult = typeof InboxListResult.Type;

// list_open_pull_requests / open_pull_request
export const OpenPullRequestsResult = Schema.Struct({
  active: Schema.NullOr(PullRequestKey),
  open: Schema.Array(
    Schema.Struct({ key: PullRequestKey, accountId: AccountId, url: Schema.String }),
  ),
});
export type OpenPullRequestsResult = typeof OpenPullRequestsResult.Type;
export const OpenInput = Schema.Struct({
  ...TargetFields,
  focus: Schema.optionalKey(
    describe(
      Schema.Boolean,
      "Show it in prkit's window and bring the window forward; true when omitted. false opens it quietly in the tab strip.",
    ),
  ),
});

// read_pull_request
export const ReadPullRequestInput = Schema.Struct({
  ...TargetFields,
  refresh: Schema.optionalKey(
    describe(Schema.Boolean, "Read GitHub now instead of prkit's cache. Spends GitHub budget."),
  ),
});
export const PullRequestResult = Schema.Struct({
  key: PullRequestKey,
  accountId: AccountId,
  url: Schema.String,
  title: Schema.String,
  body: Schema.String,
  state: PullRequestSummary.fields.state,
  isDraft: Schema.Boolean,
  author: Schema.NullOr(Schema.String),
  headBranch: Schema.String,
  baseBranch: Schema.String,
  headSha: Schema.String,
  mergeability: Schema.String,
  reviewDecision: PullRequestSummary.fields.reviewDecision,
  checks: Schema.Struct({
    passing: Schema.Int,
    failing: Schema.Int,
    pending: Schema.Int,
    failingNames: Schema.Array(Schema.String),
  }),
  additions: Schema.Int,
  deletions: Schema.Int,
  changedFiles: Schema.Int,
  files: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      previousPath: Schema.NullOr(Schema.String),
      status: Schema.String,
      additions: Schema.Int,
      deletions: Schema.Int,
    }),
  ),
  stack: Schema.NullOr(
    Schema.Struct({
      position: Schema.Int,
      size: Schema.Int,
      layers: Schema.Array(
        Schema.Struct({
          position: Schema.Int,
          number: Schema.Int,
          title: Schema.String,
          state: Schema.String,
        }),
      ),
    }),
  ),
  reviewers: PullRequestDetail.fields.reviewers,
  labels: PullRequestDetail.fields.labels,
  actions: PullRequestDetail.fields.actions,
  fetchedAt: Schema.String,
});
export type PullRequestResult = typeof PullRequestResult.Type;

// read_guide / generate_guide / stop_guide
export const GuideStatus = Schema.Struct({
  key: PullRequestKey,
  state: Schema.Literals(["none", "preparing", "writing", "watching", "failed", "done"]),
  message: Schema.NullOr(Schema.String),
  latestRevision: Schema.NullOr(Schema.Int),
  agent: Schema.NullOr(
    Schema.Struct({ instance: AgentInstanceId, model: Schema.NullOr(Schema.String) }),
  ),
  startedBy: Schema.NullOr(Schema.String),
  progress: Schema.NullOr(
    Schema.Struct({
      narration: Schema.NullOr(Schema.String),
      filesRead: Schema.Int,
      files: Schema.Int,
    }),
  ),
});
export type GuideStatus = typeof GuideStatus.Type;
export const GuideResult = Schema.Struct({
  status: GuideStatus,
  guide: Schema.NullOr(
    Schema.Struct({
      revision: Schema.Int,
      headSha: Schema.String,
      createdAt: Schema.String,
      content: NormalizedGuide,
    }),
  ),
});
export type GuideResult = typeof GuideResult.Type;
export const GenerateGuideInput = Schema.Struct({
  ...TargetFields,
  guidance: Schema.optionalKey(GuidanceEdit),
  focus: Schema.optionalKey(
    Schema.Struct({
      expectedVersion: Schema.Int,
      areas: Schema.Array(
        Schema.Struct({
          id: Schema.NullOr(GuideItemId),
          label: Schema.String,
          question: Schema.String,
        }),
      ),
      overrides: Schema.Array(GuideOverride),
    }),
  ),
  regenerate: Schema.optionalKey(Schema.Boolean),
  stack: Schema.optionalKey(Schema.Literals(["this-pr", "whole-stack", "chosen-layers"])),
  layers: Schema.optionalKey(Schema.NonEmptyArray(Schema.Int.check(Schema.isGreaterThan(0)))),
  instance: Schema.optionalKey(
    describe(
      AgentInstanceId,
      "The agent instance to write it, as prkit_status lists them. The pull request's own agent, else prkit's default, when omitted.",
    ),
  ),
  model: Schema.optionalKey(describe(Schema.NonEmptyString, "A model slug that instance offers.")),
  options: Schema.optionalKey(Schema.Array(ModelOptionSelection)),
});

// list_review_comments / add_review_comment
export const CommentsResult = Schema.Struct({
  ...PageInfo,
  drafts: Schema.Array(
    Schema.Struct({
      id: ReviewCommentId,
      path: Schema.String,
      side: Schema.Literals(["old", "new"]),
      startLine: Schema.Int,
      line: Schema.Int,
      outdated: Schema.Boolean,
      body: Schema.String,
      state: Schema.String,
    }),
  ),
  threads: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      path: Schema.String,
      line: Schema.NullOr(Schema.Int),
      outdated: Schema.Boolean,
      resolved: Schema.Boolean,
      comments: Schema.Array(
        Schema.Struct({
          author: Schema.NullOr(Schema.String),
          body: Schema.String,
          url: Schema.String,
        }),
      ),
    }),
  ),
  threadsTruncated: Schema.Boolean,
});
export type CommentsResult = typeof CommentsResult.Type;
const ClientRequestId = Schema.optionalKey(
  describe(
    Schema.String.check(Schema.isMaxLength(200)),
    "Any id you choose for this call. Retrying with the same id returns the first answer instead of adding it twice.",
  ),
);
export const AddCommentInput = Schema.Struct({
  ...TargetFields,
  path: describe(Schema.NonEmptyString, "The file's path as the diff lists it."),
  line: describe(Schema.Int, "The (last) line the comment is on."),
  startLine: Schema.optionalKey(
    describe(Schema.Int, "The first line, for a comment on several lines."),
  ),
  side: Schema.optionalKey(
    describe(
      Schema.Literals(["new", "old"]),
      "new (the pull request's version, the default) or old (the base's, for removed lines).",
    ),
  ),
  body: describe(Schema.NonEmptyString, "The comment, in Markdown."),
  clientRequestId: ClientRequestId,
});
export const AddedComment = Schema.Struct({ id: ReviewCommentId, key: PullRequestKey });
export type AddedComment = typeof AddedComment.Type;

// send_to_fix_agent / ask_fix_agent_to_change / read_fix / stop_fix / retry_fix / resolve_conflicts
export const SendToFixInput = Schema.Struct({
  ...TargetFields,
  instance: GenerateGuideInput.fields.instance,
  model: GenerateGuideInput.fields.model,
  options: GenerateGuideInput.fields.options,
  draftIds: Schema.optionalKey(
    describe(
      Schema.Array(ReviewCommentId),
      "prkit draft comments, from list_review_comments. With neither draftIds nor threadIds, every draft still waiting goes.",
    ),
  ),
  threadIds: Schema.optionalKey(
    describe(Schema.Array(Schema.String), "GitHub review threads, from list_review_comments."),
  ),
  instructions: Schema.optionalKey(
    describe(Schema.String, "Anything the fix agent should know, in a few sentences."),
  ),
  clientRequestId: ClientRequestId,
});
export const ReviseInput = Schema.Struct({
  ...TargetFields,
  instructions: describe(Schema.NonEmptyString, "What the fix agent should change in its result."),
  turnId: Schema.optionalKey(
    describe(FixerTurnId, "The fix to change; the latest one waiting for Push when omitted."),
  ),
  clientRequestId: ClientRequestId,
});
export const TurnInput = Schema.Struct({
  ...TargetFields,
  turnId: Schema.optionalKey(
    describe(FixerTurnId, "The fix to retry; the latest failed one when omitted."),
  ),
});
export const ConflictsInput = Schema.Struct({
  ...TargetFields,
  instance: GenerateGuideInput.fields.instance,
  model: GenerateGuideInput.fields.model,
  options: GenerateGuideInput.fields.options,
  strategy: Schema.optionalKey(
    describe(
      Schema.Literals(["merge", "rebase"]),
      "merge (the default) merges the base in; rebase is offered only on your own pull requests.",
    ),
  ),
});
export const StartedTurn = Schema.Struct({ key: PullRequestKey, turnId: FixerTurnId });
export type StartedTurn = typeof StartedTurn.Type;
export const FixTurnSummary = Schema.Struct({
  id: FixerTurnId,
  kind: Schema.Literals(["fix", "conflicts", "revert"]),
  state: Schema.String,
  message: Schema.NullOr(Schema.String),
  waitingForPush: Schema.Boolean,
  startedBy: Schema.NullOr(Schema.String),
  narration: Schema.NullOr(Schema.String),
  commit: Schema.NullOr(Schema.Struct({ sha: Schema.String, message: Schema.String })),
  comments: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      path: Schema.String,
      status: Schema.NullOr(Schema.String),
      note: Schema.NullOr(Schema.String),
    }),
  ),
  createdAt: Schema.String,
});
export const FixResult = Schema.Struct({
  key: PullRequestKey,
  state: Schema.Literals(["none", "idle", "working", "waiting-for-push", "done"]),
  turns: Schema.Array(FixTurnSummary),
  latestDiff: Schema.NullOr(
    Schema.Struct({ turnId: FixerTurnId, diff: Schema.String, cut: Schema.Boolean }),
  ),
});
export type FixResult = typeof FixResult.Type;
export const StopFixResult = Schema.Struct({
  ...FixResult.fields,
  note: describe(
    Schema.NullOr(Schema.String),
    "What stop_fix left running, in plain words, or null when everything it may stop stopped.",
  ),
});

// wait_for
export const WaitInput = Schema.Struct({
  ...TargetFields,
  what: describe(Schema.Literals(["guide", "fix"]), "What to wait for."),
  timeoutSeconds: Schema.optionalKey(
    describe(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 600 })),
      "How long to wait, 50 seconds when omitted, at most 600. A timeout stops only the waiting, never the work: call again to keep waiting.",
    ),
  ),
});
export const WaitResult = Schema.Struct({
  finished: Schema.Boolean,
  guide: Schema.NullOr(GuideStatus),
  fix: Schema.NullOr(FixResult),
});
export type WaitResult = typeof WaitResult.Type;
