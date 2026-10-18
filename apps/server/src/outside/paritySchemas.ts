import {
  AccountId,
  AgentCatalogEntry,
  AgentInstanceId,
  AppearanceSettings,
  AttemptConfig,
  AttemptId,
  AttemptSummary,
  ChapterReview,
  DraftGuideResult,
  FileReviewState,
  FileSide,
  FixerActivity,
  FixerFeedEntry,
  FixerSnapshot,
  FixerTurn,
  FixerTurnId,
  GuideConfigSave,
  GuideRepository,
  GuideScope,
  GuideSettings,
  InboxFilters,
  NormalizedGuide,
  OutsideAgentsState,
  PendingComments,
  PullRequestCandidates,
  PullRequestCheck,
  PullRequestDetail,
  PullRequestFile,
  PullRequestGuideConfig,
  PullRequestKey,
  PullRequestStack,
  PullRequestSummary,
  PullRequestTimeline,
  PushAccess,
  Repository,
  RepositoryList,
  RepositoryPullRequests,
  ResolvedGuideConfig,
  RevisionSummary,
  ReviewActivity,
  ReviewCommentId,
  ReviewFeedEntry,
  ReviewProgress,
  SavedInboxFilters,
  ScopeConfig,
  ScriptAccess,
  SkippedFile,
  StackGuidesResult,
  TypicalDuration,
  ReviewThread,
} from "@prkit/contracts";
import * as Schema from "effect/Schema";

import { ResponseFields } from "./responseSchemas.ts";
import { PageFields, PageInfo, pageSchema } from "./pageSchemas.ts";
import {
  AddCommentInput,
  GuideStatus,
  FixResult,
  HOST_NAME,
  ManualCheckTicked,
  OWNER_NAME,
  REPO_NAME,
  ReadPullRequestInput,
  StatusResult,
  TargetFields,
} from "./schemas.ts";

export const ListInput = Schema.Struct({ ...PageFields, accountId: Schema.optionalKey(AccountId) });
export const RefreshListInput = Schema.Struct({
  ...ListInput.fields,
  refresh: Schema.optionalKey(Schema.Boolean),
});
export const RepositoryInput = Schema.Struct({
  ...RefreshListInput.fields,
  host: Schema.optionalKey(Schema.String.check(Schema.isPattern(HOST_NAME))),
  owner: Schema.String.check(Schema.isPattern(OWNER_NAME)),
  repo: Schema.String.check(Schema.isPattern(REPO_NAME)),
});
export const PagedTargetInput = Schema.Struct({ ...ReadPullRequestInput.fields, ...PageFields });
export const AccountsResult = pageSchema(StatusResult.fields.accounts.value);
export const RepositoriesResult = Schema.Struct({
  ...pageSchema(Repository).fields,
  accounts: RepositoryList.fields.accounts,
});
export const RepositoryPullRequestsResult = Schema.Struct({
  ...pageSchema(PullRequestSummary).fields,
  githubTotal: Schema.Int,
  freshness: RepositoryPullRequests.fields.freshness,
});

/** Configuration paths, login commands and every environment value stay on the server. */
export const OutsideAgent = Schema.Struct({
  instance: AgentCatalogEntry.fields.instance,
  kind: AgentCatalogEntry.fields.kind,
  label: AgentCatalogEntry.fields.label,
  enabled: Schema.Boolean,
  isDefault: Schema.Boolean,
  version: AgentCatalogEntry.fields.version,
  ready: Schema.Boolean,
  problem: Schema.NullOr(Schema.String),
  models: AgentCatalogEntry.fields.models,
});
export const AgentsInput = Schema.Struct({
  ...PageFields,
  refresh: Schema.optionalKey(Schema.Boolean),
  instance: Schema.optionalKey(AgentInstanceId),
});
export const AgentsResult = pageSchema(OutsideAgent);
export const FilePart = Schema.Struct({
  ...PullRequestFile.fields,
  offset: Schema.Int,
  complete: Schema.Boolean,
});
export const FilesResult = Schema.Struct({
  ...pageSchema(FilePart).fields,
  headSha: Schema.NullOr(Schema.String),
  baseSha: Schema.NullOr(Schema.String),
  changedFiles: Schema.Int,
  githubTruncated: Schema.Boolean,
});
export const ReviewedFilesInput = Schema.Struct({
  ...PagedTargetInput.fields,
  revision: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThan(0)).annotate({
      description:
        "A guide revision from list_guide_revisions: its saved diff and chapters instead of the current files.",
    }),
  ),
});
export const ReviewedFile = Schema.Struct({
  path: Schema.String,
  previousPath: Schema.NullOr(Schema.String),
  state: FileReviewState,
});
export const ReviewedFilesResult = Schema.Struct({
  ...pageSchema(ReviewedFile).fields,
  headSha: Schema.String,
  revision: Schema.NullOr(Schema.Int),
  changedFiles: Schema.Int,
  githubTruncated: Schema.Boolean,
  progress: ReviewProgress,
  chapters: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      title: Schema.String,
      state: Schema.NullOr(ChapterReview.fields.state),
      progress: ReviewProgress,
    }),
  ),
});
export const MarkFilesReviewedInput = Schema.Struct({
  ...TargetFields,
  headSha: Schema.NonEmptyString.annotate({
    description:
      "The headSha read_reviewed_files returned. If the pull request moved since, nothing is marked.",
  }),
  paths: Schema.NonEmptyArray(Schema.NonEmptyString).annotate({
    description: "Changed files of the current diff, by the paths read_reviewed_files lists.",
  }),
  reviewed: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "true marks the files reviewed (when omitted); false marks them not reviewed.",
    }),
  ),
});
export const MarkedFilesResult = Schema.Struct({
  headSha: Schema.String,
  changedFiles: Schema.Int,
  githubTruncated: Schema.Boolean,
  files: Schema.Array(ReviewedFile),
  progress: ReviewProgress,
});
export const FileInput = Schema.Struct({
  ...PagedTargetInput.fields,
  path: Schema.NonEmptyString,
  side: FileSide,
});
export const TextResult = Schema.Struct({
  ...pageSchema(Schema.Struct({ offset: Schema.Int, text: Schema.String })).fields,
  sha: Schema.NullOr(Schema.String),
});
export const TimelineResult = Schema.Struct({
  ...pageSchema(PullRequestTimeline.fields.events.value).fields,
  githubTruncated: Schema.Boolean,
});
export const ThreadsResult = Schema.Struct({
  ...pageSchema(ReviewThread).fields,
  githubTruncated: Schema.Boolean,
});
export const ConversationResult = pageSchema(PullRequestDetail.fields.conversation.value);
export const ChecksResult = pageSchema(PullRequestCheck);
export const StackResult = Schema.Struct({
  stack: Schema.NullOr(Schema.Struct({ number: Schema.Int, base: Schema.String })),
  ...pageSchema(PullRequestStack.fields.layers.value).fields,
});
export const CandidatesResult = pageSchema(
  Schema.Union([
    Schema.TaggedStruct("reviewer", PullRequestCandidates.fields.reviewers.value.fields),
    Schema.TaggedStruct("team", PullRequestCandidates.fields.teams.value.fields),
    Schema.TaggedStruct("label", PullRequestCandidates.fields.labels.value.fields),
  ]),
);
export const ReviewsResult = pageSchema(ReviewFeedEntry);
export const RevisionsResult = pageSchema(RevisionSummary);
export const RevisionInput = Schema.Struct({
  ...TargetFields,
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
});
export const RevisionResult = Schema.Struct({
  revision: Schema.Int,
  headSha: Schema.String,
  createdAt: Schema.String,
  content: NormalizedGuide,
  config: AttemptConfig,
  manualCheckTicked: ManualCheckTicked,
});
export const TickManualCheckInput = Schema.Struct({
  ...TargetFields,
  revision: Schema.Int.check(Schema.isGreaterThan(0)).annotate({
    description:
      "The guide revision whose manualCheck steps you read, from read_guide or read_guide_revision.",
  }),
  steps: Schema.NonEmptyArray(Schema.Int.check(Schema.isGreaterThan(0))).annotate({
    description: "The steps to tick, by their 1-based number in that revision's manualCheck.",
  }),
  ticked: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "true ticks the steps (when omitted); false unticks them.",
    }),
  ),
});
export const TickManualCheckResult = Schema.Struct({
  revision: Schema.Int,
  manualCheckTicked: ManualCheckTicked,
});
export const ReviewDiffInput = Schema.Struct({ ...PagedTargetInput.fields, attemptId: AttemptId });
export const ProgressResult = Schema.Struct({
  status: GuideStatus,
  attempt: Schema.NullOr(
    Schema.Struct({
      ...AttemptSummary.fields,
      files: Schema.Array(AttemptSummary.fields.files.value),
    }),
  ),
  ...pageSchema(ReviewActivity).fields,
  draft: Schema.NullOr(DraftGuideResult),
});
export const DurationInput = Schema.Struct({
  ...ResponseFields,
  instance: AgentInstanceId,
  lines: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export const DurationResult = Schema.Struct({ duration: Schema.NullOr(TypicalDuration) });
export const GuideSettingsResult = Schema.Struct({
  scopes: PullRequestGuideConfig,
  resolved: ResolvedGuideConfig,
  skipped: Schema.Array(SkippedFile),
  reviewedFiles: Schema.Int,
});
export const ScopeInput = Schema.Struct({ ...ResponseFields, scope: GuideScope });
export const GuideRepositoriesResult = pageSchema(GuideRepository);
export const SaveGuideSettingsInput = Schema.Struct({
  ...TargetFields,
  expectedVersion: Schema.Int,
  edit: GuideConfigSave.fields.edit,
});
export const ScopeResult = ScopeConfig;
export const GenerateResult = Schema.Struct({
  ...GuideStatus.fields,
  stack: Schema.NullOr(StackGuidesResult),
});
export const ReorderInput = Schema.Struct({
  ...ResponseFields,
  keys: Schema.Array(PullRequestKey),
});
export const SaveInboxFiltersInput = Schema.Struct({ ...InboxFilters.fields, ...ResponseFields });
export const SavedFiltersResult = SavedInboxFilters;
export const EditCommentInput = Schema.Struct({
  ...TargetFields,
  id: ReviewCommentId,
  body: Schema.NonEmptyString,
});
export const MoveCommentInput = Schema.Struct({
  ...TargetFields,
  id: ReviewCommentId,
  path: AddCommentInput.fields.path,
  line: AddCommentInput.fields.line,
  startLine: AddCommentInput.fields.startLine,
  side: AddCommentInput.fields.side,
  headSha: AddCommentInput.fields.headSha,
});
export const CommentsResult = PendingComments;
export const FixesResult = pageSchema(FixerFeedEntry);
export const FixTurnInput = Schema.Struct({ ...PagedTargetInput.fields, turnId: FixerTurnId });
export const FixTurnResult = Schema.Struct({
  turn: FixerTurn,
  ...pageSchema(FixerActivity).fields,
  settings: FixerSnapshot.fields.settings,
  autoResolvePaused: Schema.Boolean,
});
export const FixDiffInput = Schema.Struct({
  ...FixTurnInput.fields,
  side: Schema.optionalKey(Schema.Literals(["ours", "theirs"])),
});
export const FixDiffResult = Schema.Struct({
  ...pageSchema(FilePart).fields,
  kind: Schema.Literals(["commit", "resolution"]),
  side: Schema.Literals(["ours", "theirs"]),
});
export const FixAccessResult = Schema.Struct({ push: PushAccess, scripts: ScriptAccess });
export const SettingsInput = Schema.Struct(PageFields);
export const SettingsResult = Schema.Struct({
  guides: GuideSettings,
  appearance: AppearanceSettings,
  outside: OutsideAgentsState,
  ...pageSchema(FixerSnapshot.fields.settings).fields,
});

export { GuideRepository };

export const PagedFixResult = Schema.Struct({ ...FixResult.fields, ...PageInfo });
