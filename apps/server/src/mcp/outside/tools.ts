import type * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import {
  AddCommentInput,
  AddedComment,
  AskAboutInput,
  AskAboutLocalInput,
  AskedLocalQuestion,
  AskedQuestion,
  CommentsResult,
  ConflictsInput,
  FixResult,
  StopFixResult,
  GenerateGuideInput,
  GenerateLocalGuideInput,
  GenerateLocalGuideResult,
  GuideResult,
  GuideStatus,
  InboxInput,
  InboxListResult,
  LocalGuideResult,
  LocalGuideStatus,
  LocalListInput,
  LocalListResult,
  LocalQuestionInput,
  LocalTargetInput,
  LocalWaitInput,
  LocalWaitResult,
  OpenInput,
  OpenPullRequestsResult,
  OutsideQuestion,
  OutsideToolFailure,
  PinInput,
  PinLocalInput,
  PullRequestResult,
  ReadLocalGuideInput,
  ReadLocalQuestionsInput,
  QuestionInput,
  QuestionWaitInput,
  QuestionWaitResult,
  QuestionsResult,
  ReadPullRequestInput,
  ReadQuestionsInput,
  ReviseInput,
  SendToFixInput,
  StartedTurn,
  StatusResult,
  TargetInput,
  TurnInput,
  LocalQuestionWaitInput,
  WaitInput,
  WaitResult,
} from "../../outside/schemas.ts";
import * as Parity from "../../outside/paritySchemas.ts";
import { limited, ResponseInput } from "../../outside/responseSchemas.ts";
import { OutsideToolLevel } from "./access.ts";

const TARGET_HINT =
  " Name the pull request by url, or by owner, repo and number (host when it isn't github.com).";

type ToolConfig = {
  readonly parameters: Schema.Constraint;
  readonly success: Schema.Constraint;
  readonly failure: Schema.Constraint;
  readonly failureMode: Tool.FailureMode;
};

/** A tool that only reads: listed and callable at both levels. */
const read = <Name extends string, Config extends ToolConfig, R>(
  tool: Tool.Tool<Name, Config, R>,
  title: string,
) =>
  tool
    .annotate(OutsideToolLevel, "reads")
    .annotate(Tool.Title, title)
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false);

const PrkitStatus = read(
  Tool.make("prkit_status", {
    description:
      "prkit's version and the access outside agents have, the GitHub accounts with their remaining GitHub budget, the agents that write guides and fixes (instance ids, models, whether each is ready), and how many guides and fixes are running, queued or waiting for Push. Call it first, and for an accountId or an agent instance.",
    parameters: ResponseInput,
    success: limited(StatusResult),
    failure: OutsideToolFailure,
  }),
  "prkit status",
);

const ListInbox = read(
  Tool.make("list_inbox", {
    description:
      "The pull requests that need the owner, per GitHub account, in sections: review requested, authored, involved. Each has its url, state, checks, review decision, stack position, guide state, size (bucket, changed lines, files and a reading time in minutes) and, for a review request, how long it has waited on the owner. sort orders each section, updated when omitted. Answers from prkit's cache and says when each account was read; refresh reads GitHub now and spends budget.",
    parameters: InboxInput,
    success: limited(InboxListResult),
    failure: OutsideToolFailure,
  }),
  "List the inbox",
);

const ListOpenPullRequests = read(
  Tool.make("list_open_pull_requests", {
    description: "The pull requests open as tabs in prkit, in order, and which one is active.",
    parameters: ResponseInput,
    success: limited(OpenPullRequestsResult),
    failure: OutsideToolFailure,
  }),
  "List open pull requests",
);

const ReadPullRequest = read(
  Tool.make("read_pull_request", {
    description: `A pull request's title, description, state, author, branches, checks summary and review decision, its changed files with line counts, and its stack.${TARGET_HINT} Answers from prkit's cache; refresh reads GitHub now.`,
    parameters: ReadPullRequestInput,
    success: limited(PullRequestResult),
    failure: OutsideToolFailure,
  }),
  "Read a pull request",
);

const ReadGuide = read(
  Tool.make("read_guide", {
    description: `The guide prkit's agent wrote for a pull request: its state (none, preparing, writing, watching, failed, done), progress while it is written, and the latest accepted guide (summary, steps, the before/after as a graph or a behavior diff, chapters with line notes).${TARGET_HINT}`,
    parameters: TargetInput,
    success: limited(GuideResult),
    failure: OutsideToolFailure,
  }),
  "Read the guide",
);

const ListReviewComments = read(
  Tool.make("list_review_comments", {
    description: `prkit's draft review comments on a pull request (local, not on GitHub) and its GitHub review threads, with their ids for send_to_fix_agent. Read only: replying and resolving happen in prkit.${TARGET_HINT}`,
    parameters: Parity.PagedTargetInput,
    success: limited(CommentsResult),
    failure: OutsideToolFailure,
  }),
  "List review comments",
);

const ReadFix = read(
  Tool.make("read_fix", {
    description: `The fix agent's work on a pull request: each turn's state and who started it, what it did per comment, and the latest commit's diff (cut at 60,000 characters). A turn in state ready is committed in prkit and waits for the owner to push it from prkit.${TARGET_HINT}`,
    parameters: Parity.PagedTargetInput,
    success: limited(Parity.PagedFixResult),
    failure: OutsideToolFailure,
  }),
  "Read the fix",
);

const WaitFor = read(
  Tool.make("wait_for", {
    description: `Waits until a pull request's guide or fix stops running, or the timeout passes (50 seconds unless you ask for more, at most 600), and returns its state; finished says which. A timeout never stops the work: call again to keep waiting. For a question, use wait_for_question.${TARGET_HINT}`,
    parameters: WaitInput,
    success: limited(WaitResult),
    failure: OutsideToolFailure,
  }),
  "Wait for a guide or fix",
);

const ListAccounts = read(
  Tool.make("list_accounts", {
    description:
      "Account status and per-resource remaining, reset and prkit spend. Never tokens or config directories.",
    parameters: Parity.ListInput,
    success: limited(Parity.AccountsResult),
    failure: OutsideToolFailure,
  }),
  "List accounts and GitHub budgets",
);

const ListRepositories = read(
  Tool.make("list_repositories", {
    description:
      "The cached repositories each account can see. refresh reads GitHub again; results include per-account freshness and upstream limits.",
    parameters: Parity.RefreshListInput,
    success: limited(Parity.RepositoriesResult),
    failure: OutsideToolFailure,
  }),
  "List repositories",
);

const ListRepositoryPullRequests = read(
  Tool.make("list_repository_pull_requests", {
    description:
      "One repository’s open PRs through the named account. Separate from the open app tabs. refresh reads GitHub again.",
    parameters: Parity.RepositoryInput,
    success: limited(Parity.RepositoryPullRequestsResult),
    failure: OutsideToolFailure,
  }),
  "List repository pull requests",
);

const ListAgents = read(
  Tool.make("list_agents", {
    description:
      "Agent instances, readiness, models and each model’s option descriptors. No environment values or configuration paths.",
    parameters: Parity.AgentsInput,
    success: limited(Parity.AgentsResult),
    failure: OutsideToolFailure,
  }),
  "List agents and models",
);

const ReadPullRequestFiles = read(
  Tool.make("read_pull_request_files", {
    description:
      "Changed files and their patches as bounded fragments. Follow nextCursor until null; offset and complete identify text fragments. githubTruncated reports files GitHub omitted.",
    parameters: Parity.PagedTargetInput,
    success: limited(Parity.FilesResult),
    failure: OutsideToolFailure,
  }),
  "Read files and diff",
);

const ReadReviewedFiles = read(
  Tool.make("read_reviewed_files", {
    description: `Which changed files the owner marked reviewed in prkit, and how far along they are. A file is reviewed, changed (reviewed before, then it changed: it needs another look), unreviewed, or unknown (it can't be marked and isn't counted). Without revision it reads the current files; with a guide revision it reads that guide's saved diff and adds its chapters. githubTruncated reports files GitHub omitted. The marks stay in prkit and never reach GitHub.${TARGET_HINT}`,
    parameters: Parity.ReviewedFilesInput,
    success: limited(Parity.ReviewedFilesResult),
    failure: OutsideToolFailure,
  }),
  "Read reviewed files",
);

const ReadFileContents = read(
  Tool.make("read_file_contents", {
    description:
      "A changed file’s old or new contents as bounded text pages. Concatenate items by offset; follow nextCursor.",
    parameters: Parity.FileInput,
    success: limited(Parity.TextResult),
    failure: OutsideToolFailure,
  }),
  "Read file contents",
);

const ReadTimeline = read(
  Tool.make("read_timeline", {
    description: "The PR timeline events the Conversation tab shows.",
    parameters: Parity.PagedTargetInput,
    success: limited(Parity.TimelineResult),
    failure: OutsideToolFailure,
  }),
  "Read timeline events",
);

const ReadThreads = read(
  Tool.make("read_threads", {
    description:
      "Read GitHub threads with comments, anchors and permissions. Does not reply or resolve.",
    parameters: Parity.PagedTargetInput,
    success: limited(Parity.ThreadsResult),
    failure: OutsideToolFailure,
  }),
  "Read review threads",
);

const ReadChecks = read(
  Tool.make("read_checks", {
    description:
      "Every check’s name, status, link and GitHub’s short summary of the result, from the same cached PR detail as the app.",
    parameters: Parity.PagedTargetInput,
    success: limited(Parity.ChecksResult),
    failure: OutsideToolFailure,
  }),
  "Read checks",
);

const ReadConversation = read(
  Tool.make("read_conversation", {
    description: "Issue comments, reviews and review comments from the Conversation tab.",
    parameters: Parity.PagedTargetInput,
    success: limited(Parity.ConversationResult),
    failure: OutsideToolFailure,
  }),
  "Read conversation",
);

const ReadStack = read(
  Tool.make("read_stack", {
    description:
      "The stack and its layers bottom to top. A non-stacked PR returns stack null and no layers.",
    parameters: Parity.PagedTargetInput,
    success: limited(Parity.StackResult),
    failure: OutsideToolFailure,
  }),
  "Read stack layers",
);

const ReadPullRequestCandidates = read(
  Tool.make("read_pull_request_action_candidates", {
    description:
      "Read the reviewers, teams and labels the app offers. Changing them remains an app action.",
    parameters: Parity.PagedTargetInput,
    success: limited(Parity.CandidatesResult),
    failure: OutsideToolFailure,
  }),
  "Read available reviewers and labels",
);

const ListReviews = read(
  Tool.make("list_reviews", {
    description:
      "Every guide and its current state, including stopped and failed reviews. A finite snapshot of the review feed.",
    parameters: Parity.ListInput,
    success: limited(Parity.ReviewsResult),
    failure: OutsideToolFailure,
  }),
  "List reviews",
);

const ListGuideRevisions = read(
  Tool.make("list_guide_revisions", {
    description: "The accepted guide revisions and their attempt ids, oldest first.",
    parameters: Parity.PagedTargetInput,
    success: limited(Parity.RevisionsResult),
    failure: OutsideToolFailure,
  }),
  "List guide revisions",
);

const ReadGuideRevision = read(
  Tool.make("read_guide_revision", {
    description:
      "One accepted guide and the settings frozen for it. Read its exact diff with read_review_diff using the attempt id from list_guide_revisions.",
    parameters: Parity.RevisionInput,
    success: limited(Parity.RevisionResult),
    failure: OutsideToolFailure,
  }),
  "Read a guide revision",
);

const ReadGuideProgress = read(
  Tool.make("read_guide_progress", {
    description:
      "Current narration, actual files read, draft outline, full draft and paged activity. Does not poll GitHub.",
    parameters: Parity.PagedTargetInput,
    success: limited(Parity.ProgressResult),
    failure: OutsideToolFailure,
  }),
  "Read guide progress",
);

const ReadReviewDiff = read(
  Tool.make("read_review_diff", {
    description:
      "The immutable saved diff for an attempt, as bounded file fragments. Follow nextCursor.",
    parameters: Parity.ReviewDiffInput,
    success: limited(Parity.FilesResult),
    failure: OutsideToolFailure,
  }),
  "Read an attempt diff",
);

const ReadPullRequestQuestions = read(
  Tool.make("read_pull_request_questions", {
    description: `The questions asked about a pull request's guide, oldest first, and their answers. Each has its id, the guide revision it was asked on, what it is about, its state (starting, waiting, answering, answered, stopped, failed), the conversation that answered it, the answer so far or in full, and whether it is pinned to the guide. Follow nextCursor until null; revision narrows to one guide revision.${TARGET_HINT}`,
    parameters: ReadQuestionsInput,
    success: limited(QuestionsResult),
    failure: OutsideToolFailure,
  }),
  "Read questions about a guide",
);

const WaitForQuestion = read(
  Tool.make("wait_for_question", {
    description: `Waits until one question about a pull request's guide is answered, stopped or failed, or the timeout passes (50 seconds unless you ask for more, at most 600), and returns that question; finished says which. Another agent's questions never end the wait. A timeout never stops the question: call again to keep waiting.${TARGET_HINT}`,
    parameters: QuestionWaitInput,
    success: limited(QuestionWaitResult),
    failure: OutsideToolFailure,
  }),
  "Wait for a question",
);

const ReadGuideDuration = read(
  Tool.make("read_guide_duration", {
    description:
      "The app’s duration estimate for an agent instance and changed-line count, or null when samples are insufficient.",
    parameters: Parity.DurationInput,
    success: limited(Parity.DurationResult),
    failure: OutsideToolFailure,
  }),
  "Read typical guide duration",
);

const ReadGuideSettings = read(
  Tool.make("read_guide_settings", {
    description:
      "All three scopes and their versions, resolved focus, guidance, ignore rules and look-closely paths, and files that would be skipped.",
    parameters: TargetInput,
    success: limited(Parity.GuideSettingsResult),
    failure: OutsideToolFailure,
  }),
  "Read resolved guide settings",
);

const ReadGuideScope = read(
  Tool.make("read_guide_scope", {
    description:
      "Read Global, Repository or PR guide settings with compare-and-set versions. Writes are allowed only at PR scope.",
    parameters: Parity.ScopeInput,
    success: limited(Parity.ScopeResult),
    failure: OutsideToolFailure,
  }),
  "Read guide scope",
);

const ListGuideRepositories = read(
  Tool.make("list_guide_repositories", {
    description: "Repositories with their own guide settings, by their last known name.",
    parameters: Parity.SettingsInput,
    success: limited(Parity.GuideRepositoriesResult),
    failure: OutsideToolFailure,
  }),
  "List repositories with guide settings",
);

const FindGuideRepository = read(
  Tool.make("find_guide_repository", {
    description: "Find the stable repository id used by guide settings through the named account.",
    parameters: Parity.RepositoryInput,
    success: limited(Parity.GuideRepository),
    failure: OutsideToolFailure,
  }),
  "Find a guide repository",
);

const ListFixes = read(
  Tool.make("list_fixes", {
    description: "A finite snapshot of the fix feed with status and turn counts.",
    parameters: Parity.ListInput,
    success: limited(Parity.FixesResult),
    failure: OutsideToolFailure,
  }),
  "List fix sessions",
);

const ReadFixTurn = read(
  Tool.make("read_fix_turn", {
    description:
      "A complete fix turn: per-comment or per-file report, scripts and trust decision, narration, and paged activity.",
    parameters: Parity.FixTurnInput,
    success: limited(Parity.FixTurnResult),
    failure: OutsideToolFailure,
  }),
  "Read a fix turn",
);

const ReadFixDiff = read(
  Tool.make("read_fix_diff", {
    description:
      "One turn’s diff as bounded fragments. For a resolution choose ours or theirs. Does not change a commit.",
    parameters: Parity.FixDiffInput,
    success: limited(Parity.FixDiffResult),
    failure: OutsideToolFailure,
  }),
  "Read a fix diff",
);

const ReadFixPatch = read(
  Tool.make("read_fix_patch", {
    description:
      "Copy patch as bounded text pages. Concatenate items in offset order; follow nextCursor.",
    parameters: Parity.FixTurnInput,
    success: limited(Parity.TextResult),
    failure: OutsideToolFailure,
  }),
  "Read patch text",
);

const ReadFixAccess = read(
  Tool.make("read_fix_access", {
    description:
      "Whether this PR account may push and whether the fix agent may run check scripts. Read only.",
    parameters: TargetInput,
    success: limited(Parity.FixAccessResult),
    failure: OutsideToolFailure,
  }),
  "Read fix eligibility",
);

const ReadSettings = read(
  Tool.make("read_settings", {
    description:
      "Guide defaults and auto mode, appearance, outside-agent state, and paged repository fix settings. Never environment or sensitive values.",
    parameters: Parity.SettingsInput,
    success: limited(Parity.SettingsResult),
    failure: OutsideToolFailure,
  }),
  "Read settings",
);

const LOCAL_HINT =
  " Name it by key, or by path: an absolute folder inside the repository, whose current branch (or the branch you pass) names the review. The prkit CLI sends its working directory.";

const ListLocalGuides = read(
  Tool.make("list_local_guides", {
    description:
      "Every guide of local changes prkit has (a repository's branch before a pull request exists, not pull requests), the latest changed first, with its state.",
    parameters: LocalListInput,
    success: limited(LocalListResult),
    failure: OutsideToolFailure,
  }),
  "List local guides",
);

const ReadLocalGuide = read(
  Tool.make("read_local_guide", {
    description: `A guide of local changes: its state (preparing, writing, ready, failed, stopped), progress while it is written, what the run took (base, head, files left out), and the latest guide, or the revision you ask for.${LOCAL_HINT}`,
    parameters: ReadLocalGuideInput,
    success: limited(LocalGuideResult),
    failure: OutsideToolFailure,
  }),
  "Read a local guide",
);

const WaitForLocalGuide = read(
  Tool.make("wait_for_local_guide", {
    description: `Waits until a guide of local changes stops running, or the timeout passes (50 seconds unless you ask for more, at most 600), and returns its state; finished says which. A timeout never stops the work: call again to keep waiting.${LOCAL_HINT}`,
    parameters: LocalWaitInput,
    success: limited(LocalWaitResult),
    failure: OutsideToolFailure,
  }),
  "Wait for a local guide",
);

const ReadLocalQuestions = read(
  Tool.make("read_local_questions", {
    description: `The questions asked about a guide of local changes (not a pull request), oldest first, and their answers. Each has its id, the guide revision it was asked on, what it is about, its state (starting, waiting, answering, answered, stopped, failed), the conversation that answered it, the answer so far or in full, and whether it is pinned to the guide. Follow nextCursor until null; revision narrows to one guide revision.${LOCAL_HINT}`,
    parameters: ReadLocalQuestionsInput,
    success: limited(QuestionsResult),
    failure: OutsideToolFailure,
  }),
  "Read questions about a local guide",
);

const WaitForLocalQuestion = read(
  Tool.make("wait_for_local_question", {
    description: `Waits until one question about a guide of local changes is answered, stopped or failed, or the timeout passes (50 seconds unless you ask for more, at most 600), and returns that question; finished says which. A timeout never stops the question: call again to keep waiting.${LOCAL_HINT}`,
    parameters: LocalQuestionWaitInput,
    success: limited(QuestionWaitResult),
    failure: OutsideToolFailure,
  }),
  "Wait for a local question",
);

/**
 * The outside endpoint's tools. A "starts work" tool is declared with `work`, which sets its
 * level and hides it while `canStartWork` says no, in one step; handlers check the level again
 * on every call (access.ts).
 */
export const makeOutsideToolkit = (canStartWork: () => boolean) => {
  /** A tool that starts work in prkit: listed and callable only at "Read and start work". */
  const work = <Name extends string, Config extends ToolConfig, R>(
    tool: Tool.Tool<Name, Config, R>,
    title: string,
    idempotent: boolean,
  ) =>
    tool
      .annotate(OutsideToolLevel, "starts-work")
      .annotate(McpSchema.EnabledWhen, () => canStartWork())
      .annotate(Tool.Title, title)
      .annotate(Tool.Readonly, false)
      .annotate(Tool.Destructive, false)
      .annotate(Tool.Idempotent, idempotent)
      .annotate(Tool.OpenWorld, false);

  const OpenPullRequest = work(
    Tool.make("open_pull_request", {
      description: `Opens a pull request as a tab in prkit and shows it in prkit's window, which comes forward.${TARGET_HINT}`,
      parameters: OpenInput,
      success: limited(OpenPullRequestsResult),
      failure: OutsideToolFailure,
    }),
    "Open a pull request in prkit",
    true,
  );

  const GenerateGuide = work(
    Tool.make("generate_guide", {
      description: `Starts prkit's agent writing a guide for a pull request, or a new one on a finished guide. It takes minutes and queues behind other agent work: call wait_for, then read_guide. instance, model and options pick the agent (list_agents lists them). guidance and focus save this PR’s settings with expectedVersion. stack selects this-pr, whole-stack or chosen-layers; regenerate includes layers with guides. Otherwise the pull request’s own agent or prkit’s default. Refused with the reason when that agent isn't ready.${TARGET_HINT}`,
      parameters: GenerateGuideInput,
      success: limited(Parity.GenerateResult),
      failure: OutsideToolFailure,
    }),
    "Generate a guide",
    false,
  );

  const StopGuide = work(
    Tool.make("stop_guide", {
      description: `Stops a pull request's guide: the running attempt ends, and prkit stops watching the pull request for new commits. Written guides stay readable.${TARGET_HINT}`,
      parameters: TargetInput,
      success: limited(GuideStatus),
      failure: OutsideToolFailure,
    }),
    "Stop the guide",
    true,
  );

  const AskAboutPullRequest = work(
    Tool.make("ask_about_pull_request", {
      description: `Asks the agent that wrote a pull request's guide a question about the whole pull request, one chapter or some diff lines, on the latest accepted guide revision unless revision says. It returns at once with the question's id: call wait_for_question with it for the answer. The answer is read-only and never touches the pull request or GitHub. Only one question is answered at a time; asking again after a stop or failure is how to retry.${TARGET_HINT}`,
      parameters: AskAboutInput,
      success: limited(AskedQuestion),
      failure: OutsideToolFailure,
    }),
    "Ask about a pull request",
    false,
  );

  const StopQuestion = work(
    Tool.make("stop_question", {
      description: `Stops a question that is still being answered. What the agent wrote so far stays as the answer.${TARGET_HINT}`,
      parameters: QuestionInput,
      success: limited(OutsideQuestion),
      failure: OutsideToolFailure,
    }),
    "Stop a question",
    true,
  );

  const PinAnswer = work(
    Tool.make("pin_answer", {
      description: `Pins an answered question and its answer to its chapter in the guide in prkit, or unpins it. Local to prkit: nothing goes to GitHub.${TARGET_HINT}`,
      parameters: PinInput,
      success: limited(OutsideQuestion),
      failure: OutsideToolFailure,
    }),
    "Pin an answer to the guide",
    true,
  );

  const AddReviewComment = work(
    Tool.make("add_review_comment", {
      description: `Adds a draft review comment in prkit on lines of a pull request's diff. It stays in prkit: nothing is posted to GitHub. Send it to the fix agent with send_to_fix_agent; posting it is the owner's click in prkit.${TARGET_HINT}`,
      parameters: AddCommentInput,
      success: limited(AddedComment),
      failure: OutsideToolFailure,
    }),
    "Add a draft comment",
    false,
  );

  const SendToFixAgent = work(
    Tool.make("send_to_fix_agent", {
      description: `Sends prkit draft comments and GitHub review threads to prkit's fix agent, which edits the pull request's branch in its own checkout and commits in prkit. Work started here never pushes by itself: it waits for the owner to push it from prkit. Call wait_for, then read_fix.${TARGET_HINT}`,
      parameters: SendToFixInput,
      success: limited(StartedTurn),
      failure: OutsideToolFailure,
    }),
    "Send to the fix agent",
    false,
  );

  const AskFixAgentToChange = work(
    Tool.make("ask_fix_agent_to_change", {
      description: `Asks the fix agent to change a fix that waits for Push (the latest one unless turnId says), in its own words. The new result waits for Push too.${TARGET_HINT}`,
      parameters: ReviseInput,
      success: limited(StartedTurn),
      failure: OutsideToolFailure,
    }),
    "Ask the fix agent to change",
    false,
  );

  const StopFix = work(
    Tool.make("stop_fix", {
      description: `Stops the fix agent's queued and running work on a pull request. Commits waiting for Push stay, and so does one it is changing: discarding them, and ending the session, are the owner's clicks in prkit.${TARGET_HINT}`,
      parameters: TargetInput,
      success: limited(StopFixResult),
      failure: OutsideToolFailure,
    }),
    "Stop the fix agent",
    true,
  );

  const RetryFix = work(
    Tool.make("retry_fix", {
      description: `Runs a failed fix or conflict resolution again (the latest failed one unless turnId says). Reverts run again only from prkit.${TARGET_HINT}`,
      parameters: TurnInput,
      success: limited(FixResult),
      failure: OutsideToolFailure,
    }),
    "Retry a fix",
    false,
  );

  const ResolveConflicts = work(
    Tool.make("resolve_conflicts", {
      description: `Asks the fix agent to resolve a pull request's merge conflicts by merging the base in (or rebasing, on the owner's own pull requests only). The result waits for Push in prkit.${TARGET_HINT}`,
      parameters: ConflictsInput,
      success: limited(FixResult),
      failure: OutsideToolFailure,
    }),
    "Resolve conflicts",
    false,
  );

  const ClosePullRequest = work(
    Tool.make("close_pull_request_tab", {
      description: "Close a tab locally. Keeps its guide, fix session and commits.",
      parameters: TargetInput,
      success: limited(OpenPullRequestsResult),
      failure: OutsideToolFailure,
    }),
    "Close a pull request tab",
    true,
  );

  const FocusPullRequest = work(
    Tool.make("focus_pull_request_tab", {
      description: "Focus an already open PR tab in prkit.",
      parameters: TargetInput,
      success: limited(OpenPullRequestsResult),
      failure: OutsideToolFailure,
    }),
    "Focus a pull request tab",
    true,
  );

  const ReorderPullRequests = work(
    Tool.make("reorder_pull_request_tabs", {
      description: "Save the complete open-tab order. Refuses a stale list.",
      parameters: Parity.ReorderInput,
      success: limited(OpenPullRequestsResult),
      failure: OutsideToolFailure,
    }),
    "Reorder pull request tabs",
    true,
  );

  const SaveInboxFilters = work(
    Tool.make("save_inbox_filters", {
      description:
        "Persist the app’s search, account, repository filter and sort for the next launch. It replaces all four, so send all four.",
      parameters: Parity.SaveInboxFiltersInput,
      success: limited(Parity.SavedFiltersResult),
      failure: OutsideToolFailure,
    }),
    "Save inbox filters",
    true,
  );

  const SavePullRequestGuideSettings = work(
    Tool.make("save_pull_request_guide_settings", {
      description:
        "Save one PR-scope ignore, sensitive (look-closely paths), focus or guidance section with expectedVersion. Read read_guide_settings first. Cannot edit Global or Repository settings.",
      parameters: Parity.SaveGuideSettingsInput,
      success: limited(Parity.ScopeResult),
      failure: OutsideToolFailure,
    }),
    "Save PR guide settings",
    true,
  );

  const EditReviewComment = work(
    Tool.make("edit_review_comment", {
      description:
        "Edit local draft text on the named PR and account. Nothing is posted to GitHub.",
      parameters: Parity.EditCommentInput,
      success: limited(Parity.CommentsResult),
      failure: OutsideToolFailure,
    }),
    "Edit a draft comment",
    true,
  );

  const MoveReviewComment = work(
    Tool.make("move_review_comment", {
      description:
        "Move a local draft to lines of the named PR's diff now, on that PR and account. prkit keeps the rows around them, so the draft follows its code. Nothing is posted to GitHub.",
      parameters: Parity.MoveCommentInput,
      success: limited(Parity.CommentsResult),
      failure: OutsideToolFailure,
    }),
    "Move a draft comment",
    true,
  );

  const MarkFilesReviewed = work(
    Tool.make("mark_files_reviewed", {
      description: `Marks changed files of a pull request's current diff reviewed, or not reviewed with reviewed: false, as the owner's checkbox does in prkit. Pass the headSha read_reviewed_files returned. If the pull request moved since, nothing is marked and it answers conflict. It sets, never toggles, so repeating a call changes nothing. The marks stay in prkit and never reach GitHub.${TARGET_HINT}`,
      parameters: Parity.MarkFilesReviewedInput,
      success: limited(Parity.MarkedFilesResult),
      failure: OutsideToolFailure,
    }),
    "Mark files reviewed",
    true,
  );

  const GenerateLocalGuide = work(
    Tool.make("generate_local_guide", {
      description:
        "Starts prkit's agent writing a guide of the changes in a local git repository, before a pull request exists: its working tree (commits since the base plus uncommitted and untracked files) on the current branch, or with branch, that branch's last commit. prkit copies a snapshot and never changes the repository. Run it again after more changes for the next revision; with nothing new it says so and starts nothing. A problem with the repository is answered at once. It takes minutes and queues behind other agent work: call wait_for_local_guide, then read_local_guide. instance, model and options pick the agent (list_agents lists them).",
      parameters: GenerateLocalGuideInput,
      success: limited(GenerateLocalGuideResult),
      failure: OutsideToolFailure,
    }),
    "Generate a local guide",
    false,
  );

  const StopLocalGuide = work(
    Tool.make("stop_local_guide", {
      description: `Stops a guide of local changes while it is written. Written revisions stay readable, and generating it again starts the next one.${LOCAL_HINT}`,
      parameters: LocalTargetInput,
      success: limited(LocalGuideStatus),
      failure: OutsideToolFailure,
    }),
    "Stop a local guide",
    true,
  );

  const AskAboutLocalChanges = work(
    Tool.make("ask_about_local_changes", {
      description: `Asks the agent that wrote a guide of local changes (not a pull request) a question about all the changes, one chapter or some diff lines, on the latest accepted guide revision unless revision says. It returns at once with the question's id: call wait_for_local_question with it for the answer. The answer is read-only and never touches the repository. Only one question per local review is answered at a time; asking again after a stop or failure is how to retry.${LOCAL_HINT}`,
      parameters: AskAboutLocalInput,
      success: limited(AskedLocalQuestion),
      failure: OutsideToolFailure,
    }),
    "Ask about local changes",
    false,
  );

  const StopLocalQuestion = work(
    Tool.make("stop_local_question", {
      description: `Stops a question about a guide of local changes that is still being answered. What the agent wrote so far stays as the answer.${LOCAL_HINT}`,
      parameters: LocalQuestionInput,
      success: limited(OutsideQuestion),
      failure: OutsideToolFailure,
    }),
    "Stop a local question",
    true,
  );

  const PinLocalAnswer = work(
    Tool.make("pin_local_answer", {
      description: `Pins an answered question and its answer to its chapter in the local guide in prkit, or unpins it. Local to prkit: it never touches the repository.${LOCAL_HINT}`,
      parameters: PinLocalInput,
      success: limited(OutsideQuestion),
      failure: OutsideToolFailure,
    }),
    "Pin a local answer to the guide",
    true,
  );

  const TickManualCheck = work(
    Tool.make("tick_manual_check_steps", {
      description: `Ticks steps of a guide's manualCheck (how to see the change working by hand), or unticks them with ticked: false, as the owner's checkbox does in prkit. Name the revision you read and the steps by their 1-based number. A tick follows its step into later revisions while the step reads the same, and stays only while the code of the step's chapter reads the same: after a real edit to it, read_guide lists the step in manualCheckChanged and not in manualCheckTicked. A tick made here records the chapter's code like the owner's checkbox does. It sets, never toggles, so repeating a call changes nothing. The ticks stay in prkit and never reach GitHub.${TARGET_HINT}`,
      parameters: Parity.TickManualCheckInput,
      success: limited(Parity.TickManualCheckResult),
      failure: OutsideToolFailure,
    }),
    "Tick manual check steps",
    true,
  );

  return Toolkit.make(
    PrkitStatus,
    ListInbox,
    ListOpenPullRequests,
    ReadPullRequest,
    ReadGuide,
    ListReviewComments,
    ReadFix,
    WaitFor,
    ListAccounts,
    ListRepositories,
    ListRepositoryPullRequests,
    ListAgents,
    ReadPullRequestFiles,
    ReadReviewedFiles,
    ReadFileContents,
    ReadTimeline,
    ReadThreads,
    ReadChecks,
    ReadConversation,
    ReadStack,
    ReadPullRequestCandidates,
    ListReviews,
    ListGuideRevisions,
    ReadGuideRevision,
    ReadGuideProgress,
    ReadReviewDiff,
    ReadPullRequestQuestions,
    WaitForQuestion,
    ReadGuideDuration,
    ReadGuideSettings,
    ReadGuideScope,
    ListGuideRepositories,
    FindGuideRepository,
    ListFixes,
    ReadFixTurn,
    ReadFixDiff,
    ReadFixPatch,
    ReadFixAccess,
    ReadSettings,
    ListLocalGuides,
    ReadLocalGuide,
    WaitForLocalGuide,
    ReadLocalQuestions,
    WaitForLocalQuestion,
    OpenPullRequest,
    GenerateGuide,
    StopGuide,
    AskAboutPullRequest,
    StopQuestion,
    PinAnswer,
    AddReviewComment,
    SendToFixAgent,
    AskFixAgentToChange,
    StopFix,
    RetryFix,
    ResolveConflicts,
    ClosePullRequest,
    FocusPullRequest,
    ReorderPullRequests,
    SaveInboxFilters,
    SavePullRequestGuideSettings,
    EditReviewComment,
    MoveReviewComment,
    MarkFilesReviewed,
    GenerateLocalGuide,
    StopLocalGuide,
    AskAboutLocalChanges,
    StopLocalQuestion,
    PinLocalAnswer,
    TickManualCheck,
  );
};

export type OutsideToolkit = ReturnType<typeof makeOutsideToolkit>;
