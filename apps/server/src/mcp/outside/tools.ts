import type * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import {
  AddCommentInput,
  AddedComment,
  CommentsResult,
  ConflictsInput,
  FixResult,
  StopFixResult,
  GenerateGuideInput,
  GuideResult,
  GuideStatus,
  InboxInput,
  InboxListResult,
  OpenInput,
  OpenPullRequestsResult,
  OutsideToolFailure,
  PullRequestResult,
  ReadPullRequestInput,
  ReviseInput,
  SendToFixInput,
  StartedTurn,
  StatusResult,
  TargetInput,
  TurnInput,
  WaitInput,
  WaitResult,
} from "../../outside/schemas.ts";
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
    parameters: Tool.EmptyParams,
    success: StatusResult,
    failure: OutsideToolFailure,
  }),
  "prkit status",
);

const ListInbox = read(
  Tool.make("list_inbox", {
    description:
      "The pull requests that need the owner, per GitHub account, in sections: review requested, authored, involved. Each has its url, state, checks, review decision, stack position and guide state. Answers from prkit's cache and says when each account was read; refresh reads GitHub now and spends budget.",
    parameters: InboxInput,
    success: InboxListResult,
    failure: OutsideToolFailure,
  }),
  "List the inbox",
);

const ListOpenPullRequests = read(
  Tool.make("list_open_pull_requests", {
    description: "The pull requests open as tabs in prkit, in order, and which one is active.",
    parameters: Tool.EmptyParams,
    success: OpenPullRequestsResult,
    failure: OutsideToolFailure,
  }),
  "List open pull requests",
);

const ReadPullRequest = read(
  Tool.make("read_pull_request", {
    description: `A pull request's title, description, state, author, branches, checks summary and review decision, its changed files with line counts, and its stack.${TARGET_HINT} Answers from prkit's cache; refresh reads GitHub now.`,
    parameters: ReadPullRequestInput,
    success: PullRequestResult,
    failure: OutsideToolFailure,
  }),
  "Read a pull request",
);

const ReadGuide = read(
  Tool.make("read_guide", {
    description: `The guide prkit's agent wrote for a pull request: its state (none, preparing, writing, watching, failed, done), progress while it is written, and the latest accepted guide (summary, steps, flow, chapters with line notes).${TARGET_HINT}`,
    parameters: TargetInput,
    success: GuideResult,
    failure: OutsideToolFailure,
  }),
  "Read the guide",
);

const ListReviewComments = read(
  Tool.make("list_review_comments", {
    description: `prkit's draft review comments on a pull request (local, not on GitHub) and its GitHub review threads, with their ids for send_to_fix_agent. Read only: replying and resolving happen in prkit.${TARGET_HINT}`,
    parameters: TargetInput,
    success: CommentsResult,
    failure: OutsideToolFailure,
  }),
  "List review comments",
);

const ReadFix = read(
  Tool.make("read_fix", {
    description: `The fix agent's work on a pull request: each turn's state and who started it, what it did per comment, and the latest commit's diff (cut at 60,000 characters). A turn in state ready is committed in prkit and waits for the owner to push it from prkit.${TARGET_HINT}`,
    parameters: TargetInput,
    success: FixResult,
    failure: OutsideToolFailure,
  }),
  "Read the fix",
);

const WaitFor = read(
  Tool.make("wait_for", {
    description: `Waits until a pull request's guide or fix stops running, or the timeout passes (50 seconds unless you ask for more, at most 600), and returns its state; finished says which. A timeout never stops the work: call again to keep waiting.${TARGET_HINT}`,
    parameters: WaitInput,
    success: WaitResult,
    failure: OutsideToolFailure,
  }),
  "Wait for a guide or fix",
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
      success: OpenPullRequestsResult,
      failure: OutsideToolFailure,
    }),
    "Open a pull request in prkit",
    true,
  );

  const GenerateGuide = work(
    Tool.make("generate_guide", {
      description: `Starts prkit's agent writing a guide for a pull request, or a new one on a finished guide. It takes minutes and queues behind other agent work: call wait_for, then read_guide. instance and model pick the agent (prkit_status lists them); otherwise the pull request's own or prkit's default. Refused with the reason when that agent isn't ready.${TARGET_HINT}`,
      parameters: GenerateGuideInput,
      success: GuideStatus,
      failure: OutsideToolFailure,
    }),
    "Generate a guide",
    false,
  );

  const StopGuide = work(
    Tool.make("stop_guide", {
      description: `Stops a pull request's guide: the running attempt ends, and prkit stops watching the pull request for new commits. Written guides stay readable.${TARGET_HINT}`,
      parameters: TargetInput,
      success: GuideStatus,
      failure: OutsideToolFailure,
    }),
    "Stop the guide",
    true,
  );

  const AddReviewComment = work(
    Tool.make("add_review_comment", {
      description: `Adds a draft review comment in prkit on lines of a pull request's diff. It stays in prkit: nothing is posted to GitHub. Send it to the fix agent with send_to_fix_agent; posting it is the owner's click in prkit.${TARGET_HINT}`,
      parameters: AddCommentInput,
      success: AddedComment,
      failure: OutsideToolFailure,
    }),
    "Add a draft comment",
    false,
  );

  const SendToFixAgent = work(
    Tool.make("send_to_fix_agent", {
      description: `Sends prkit draft comments and GitHub review threads to prkit's fix agent, which edits the pull request's branch in its own checkout and commits in prkit. Work started here never pushes by itself: it waits for the owner to push it from prkit. Call wait_for, then read_fix.${TARGET_HINT}`,
      parameters: SendToFixInput,
      success: StartedTurn,
      failure: OutsideToolFailure,
    }),
    "Send to the fix agent",
    false,
  );

  const AskFixAgentToChange = work(
    Tool.make("ask_fix_agent_to_change", {
      description: `Asks the fix agent to change a fix that waits for Push (the latest one unless turnId says), in its own words. The new result waits for Push too.${TARGET_HINT}`,
      parameters: ReviseInput,
      success: StartedTurn,
      failure: OutsideToolFailure,
    }),
    "Ask the fix agent to change",
    false,
  );

  const StopFix = work(
    Tool.make("stop_fix", {
      description: `Stops the fix agent's queued and running work on a pull request. Commits waiting for Push stay, and so does one it is changing: discarding them, and ending the session, are the owner's clicks in prkit.${TARGET_HINT}`,
      parameters: TargetInput,
      success: StopFixResult,
      failure: OutsideToolFailure,
    }),
    "Stop the fix agent",
    true,
  );

  const RetryFix = work(
    Tool.make("retry_fix", {
      description: `Runs a failed fix or conflict resolution again (the latest failed one unless turnId says). Reverts run again only from prkit.${TARGET_HINT}`,
      parameters: TurnInput,
      success: FixResult,
      failure: OutsideToolFailure,
    }),
    "Retry a fix",
    false,
  );

  const ResolveConflicts = work(
    Tool.make("resolve_conflicts", {
      description: `Asks the fix agent to resolve a pull request's merge conflicts by merging the base in (or rebasing, on the owner's own pull requests only). The result waits for Push in prkit.${TARGET_HINT}`,
      parameters: ConflictsInput,
      success: FixResult,
      failure: OutsideToolFailure,
    }),
    "Resolve conflicts",
    false,
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
    OpenPullRequest,
    GenerateGuide,
    StopGuide,
    AddReviewComment,
    SendToFixAgent,
    AskFixAgentToChange,
    StopFix,
    RetryFix,
    ResolveConflicts,
  );
};

export type OutsideToolkit = ReturnType<typeof makeOutsideToolkit>;
