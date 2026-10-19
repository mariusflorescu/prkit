import {
  type AccountId,
  forReader,
  matchesInboxFilter,
  orderInbox,
  primaryInboxReason,
  pullRequestSize,
  type FixerSnapshot,
  type FixerTurn,
  type FixerTurnId,
  type FixTarget,
  placeOn,
  type PullRequestKey,
  pullRequestKey,
  refFromKey,
  type ReviewSnapshot,
} from "@prkit/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { GitHubAccounts } from "../accounts/GitHubAccounts.ts";
import { Agents } from "../agents/Agents.ts";
import * as ServerConfig from "../config.ts";
import { Fixers } from "../fixers/Fixers.ts";
import { GitHubApi } from "../github/GitHubApi.ts";
import { PullRequests } from "../pullRequests/PullRequests.ts";
import { ReviewComments } from "../reviewComments/ReviewComments.ts";
import { ManualCheckTicks } from "../manualCheck/ManualCheckTicks.ts";
import { Reviews } from "../reviews/Reviews.ts";
import { Workspace } from "../workspace/Workspace.ts";
import { makeOutsideReads } from "./OutsideReads.ts";
import { makeOutsideActions } from "./OutsideActions.ts";
import { makeOutsideLocal } from "./OutsideLocal.ts";
import { makeOutsideAsks } from "./OutsideAsks.ts";
import { makeIdempotent } from "./idempotent.ts";
import { requestedAgent } from "./agentSelection.ts";
import { placementOn } from "./githubLines.ts";
import { makePager, type PageInput } from "./paging.ts";
import { asFailure, fail } from "./errors.ts";
import { OutsideAgents } from "./OutsideAgents.ts";
import {
  AddedComment,
  type FixResult,
  type GuideResult,
  type GuideStatus,
  type InboxListResult,
  InboxInput,
  SendToFixInput,
  ConflictsInput,
  type OpenPullRequestsResult,
  type PullRequestResult,
  StartedTurn,
  type StatusResult,
  Target,
  type TargetInput,
  type WaitResult,
  WAIT_DEFAULT_SECONDS,
  HOST_NAME,
  OWNER_NAME,
  REPO_NAME,
} from "./schemas.ts";

const DIFF_LIMIT = 60_000;
const WORKING_TURNS = new Set(["queued", "preparing", "running", "pushing"]);

/** A PR URL: `https://<host>/<owner>/<repo>/pull/<number>`, anything after the number ignored. */
const parseUrl = (url: string) => {
  const match = /^https?:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/pull\/([1-9]\d*)(?:[/?#].*)?$/.exec(
    url.trim(),
  );
  if (match === null) return null;
  const [, host, owner, repo, number] = match;
  if (host === undefined || owner === undefined || repo === undefined || number === undefined)
    return null;
  return { host: host.toLowerCase(), owner, repo, number: Number(number) };
};

const webUrl = (key: PullRequestKey) => {
  const ref = refFromKey(key);
  return ref === null ? "" : `https://${ref.host}/${ref.owner}/${ref.repo}/pull/${ref.number}`;
};

/**
 * What outside agents can ask of prkit, one method per MCP tool, each a thin layer over the
 * service the app's own buttons use (docs/features/outside-agents.md). Reads answer from
 * prkit's cache; work counts as a click and queues behind the agent slots like one.
 */
export class OutsideWork extends Context.Service<OutsideWork, Effect.Success<typeof make>>()(
  "@prkit/server/outside/OutsideWork",
) {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const config = yield* ServerConfig.ServerConfig;
  const page = yield* makePager;
  const accounts = yield* GitHubAccounts;
  const github = yield* GitHubApi;
  const agents = yield* Agents;
  const pullRequests = yield* PullRequests;
  const workspace = yield* Workspace;
  const reviews = yield* Reviews;
  const reviewComments = yield* ReviewComments;
  const manualCheckTicks = yield* ManualCheckTicks;
  const fixers = yield* Fixers;
  const outsideAgents = yield* OutsideAgents;
  const idempotent = yield* makeIdempotent;

  /**
   * The account a PR is read through: the one asked for, else the one prkit already bound it
   * to or whose inbox has it. Never "whichever token works": with none or several, the
   * client must say which (AGENTS.md "The right account, every time").
   */
  const resolve = (input: TargetInput) =>
    Effect.gen(function* () {
      const ref =
        input.url === undefined
          ? input.owner === undefined || input.repo === undefined || input.number === undefined
            ? null
            : {
                host: (input.host ?? "github.com").toLowerCase(),
                owner: input.owner,
                repo: input.repo,
                number: input.number,
              }
          : parseUrl(input.url);
      if (
        ref === null ||
        ref.number < 1 ||
        !HOST_NAME.test(ref.host) ||
        !OWNER_NAME.test(ref.owner) ||
        !REPO_NAME.test(ref.repo)
      )
        return yield* fail(
          "invalid",
          "Name the pull request by its URL, or by owner, repo and number (and host when it isn't github.com).",
        );
      const key = pullRequestKey(ref);
      const known = (yield* accounts.list()).accounts.filter(
        (account) => account.host === ref.host,
      );
      const names = known.map((account) => account.id).join(", ") || "none";
      if (input.accountId !== undefined) {
        if (!known.some((account) => account.id === input.accountId))
          return yield* fail(
            "account-needed",
            `prkit has no account ${input.accountId} on ${ref.host}. Accounts there: ${names}.`,
          );
        return { key, accountId: input.accountId, url: webUrl(key) } satisfies typeof Target.Type;
      }
      const found = new Set<AccountId>();
      const open = (yield* workspace.get()).open.find((row) => row.key === key);
      if (open !== undefined) found.add(open.accountId);
      const review = (yield* reviews.get(key)).review;
      if (review !== null) found.add(review.accountId);
      const fixer = (yield* fixers.get(key)).fixer;
      if (fixer !== null && fixer.status._tag === "active") found.add(fixer.accountId);
      for (const accountId of yield* pullRequests.inboxAccountsOf(key)) found.add(accountId);
      // Found by none, the one ready account on the host reads it, as pasting a URL does in prkit.
      const ready = known.filter((account) => account.status._tag === "ready");
      if (found.size === 0 && ready.length === 1 && ready[0] !== undefined) found.add(ready[0].id);
      const [only, ...others] = [...found];
      if (only !== undefined && others.length === 0)
        return { key, accountId: only, url: webUrl(key) } satisfies typeof Target.Type;
      return yield* fail(
        "account-needed",
        only === undefined
          ? `No account's inbox in prkit has ${key}. Pass accountId, one of: ${names}.`
          : `Several accounts reach ${key}: ${[only, ...others].join(", ")}. Pass accountId to say which.`,
      );
    }).pipe(Effect.mapError(asFailure));

  const questions = yield* makeOutsideAsks(resolve, idempotent);

  // Reads.

  const status = () =>
    Effect.gen(function* () {
      const list = yield* accounts.list();
      const budget = yield* github.budget;
      const catalog = yield* agents.catalog();
      const counts = yield* sql`
        SELECT
          (SELECT COUNT(*) FROM reviews WHERE json_extract(status, '$._tag') = 'writing') AS guidesRunning,
          (SELECT COUNT(*) FROM reviews WHERE json_extract(status, '$._tag') = 'preparing') AS guidesQueued,
          (SELECT COUNT(*) FROM fixer_turns WHERE json_extract(status, '$._tag') IN ('preparing', 'running', 'pushing')) AS fixesRunning,
          (SELECT COUNT(*) FROM fixer_turns WHERE json_extract(status, '$._tag') = 'queued') AS fixesQueued,
          (SELECT COUNT(*) FROM fixer_turns WHERE json_extract(status, '$._tag') = 'ready') AS fixesWaitingForPush`.pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Array(
              Schema.Struct({
                guidesRunning: Schema.Int,
                guidesQueued: Schema.Int,
                fixesRunning: Schema.Int,
                fixesQueued: Schema.Int,
                fixesWaitingForPush: Schema.Int,
              }),
            ),
          ),
        ),
      );
      const result: StatusResult = {
        version: config.version,
        access: outsideAgents.current().access,
        accounts: list.accounts.map((account) => ({
          accountId: account.id,
          login: account.login,
          host: account.host,
          ready: account.status._tag === "ready",
          problem: account.status._tag === "error" ? account.status.message : null,
          budget: budget.accounts.find((entry) => entry.accountId === account.id)?.limits ?? [],
        })),
        agents: catalog.providers.map((entry) => ({
          instance: entry.instance,
          label: entry.label,
          kind: entry.kind,
          enabled: entry.enabled,
          isDefault: entry.isDefault,
          ready: entry.state._tag === "ready",
          problem: entry.state._tag === "unavailable" ? entry.state.message : null,
          models: entry.models.map((model) => ({ slug: model.slug, name: model.name })),
        })),
        work: counts[0] ?? {
          guidesRunning: 0,
          guidesQueued: 0,
          fixesRunning: 0,
          fixesQueued: 0,
          fixesWaitingForPush: 0,
        },
      };
      return result;
    }).pipe(Effect.mapError(asFailure));

  const inbox = (input: typeof InboxInput.Type) =>
    Effect.gen(function* () {
      const result = yield* pullRequests.inbox(
        input.refresh === true && input.cursor === undefined
          ? { _tag: "refresh" }
          : { _tag: "cached" },
      );
      const { cursor: _cursor, limit: _limit, refresh: _refresh, ...filters } = input;
      const filterKey = yield* Schema.encodeEffect(Schema.fromJsonString(InboxInput))(filters);
      const reviewed = new Map((yield* reviews.index()).map((review) => [review.key, review]));
      const filtered = orderInbox(
        result.entries.filter((entry) =>
          matchesInboxFilter(
            entry,
            input.search ?? "",
            input.accountId ?? null,
            input.repository ?? null,
            input,
          ),
        ),
        input.sort,
        (entry) => reviewed.get(pullRequestKey(entry.ref))?.risk ?? null,
      );
      const paged = yield* page(
        filtered,
        input,
        `inbox:${filterKey}:${filtered.map((entry) => `${pullRequestKey(entry.ref)}:${entry.updatedAt}`).join(",")}`,
      );
      const listed: InboxListResult = {
        githubTruncated: result.truncated.filter(
          (entry) =>
            (input.accountId === undefined || entry.accountId === input.accountId) &&
            (input.reason === undefined || entry.reason === input.reason),
        ),
        nextCursor: paged.nextCursor,
        total: paged.total,
        truncated: paged.truncated,
        message: paged.message,
        accounts: result.accounts
          .filter((row) => input.accountId === undefined || row.accountId === input.accountId)
          .map((row) => {
            const entries = paged.items.filter((entry) => entry.accountId === row.accountId);
            const reasons = ["review-requested", "authored", "involved"] as const;
            return {
              accountId: row.accountId,
              fetchedAt: row.fetchedAt,
              problem: row.problem,
              sections: reasons
                .map((reason) => ({
                  reason,
                  pullRequests: entries
                    .filter((entry) => primaryInboxReason(entry.reasons) === reason)
                    .map((entry) => {
                      const key = pullRequestKey(entry.ref);
                      const review = reviewed.get(key);
                      return {
                        key,
                        url: entry.url,
                        title: entry.title,
                        author: entry.author?.login ?? null,
                        state: entry.state,
                        isDraft: entry.isDraft,
                        createdAt: entry.createdAt,
                        updatedAt: entry.updatedAt,
                        size: pullRequestSize(entry),
                        wait: entry.wait,
                        checks: entry.checks,
                        reviewDecision: entry.reviewDecision,
                        reasons: entry.reasons,
                        stack:
                          entry.stack === null
                            ? null
                            : `Stack ${entry.stack.position}/${entry.stack.size}`,
                        guide: review?.status ?? null,
                        risk: review?.risk ?? null,
                      };
                    }),
                }))
                .filter((section) => section.pullRequests.length > 0),
            };
          }),
      };
      return listed;
    }).pipe(Effect.mapError(asFailure));

  const openPullRequests = () =>
    workspace.get().pipe(
      Effect.map((current): OpenPullRequestsResult => ({
        active: current.activeKey,
        open: current.open.map((row) => ({
          key: row.key,
          accountId: row.accountId,
          url: webUrl(row.key),
        })),
      })),
      Effect.mapError(asFailure),
    );

  const pullRequest = (input: TargetInput & { readonly refresh?: boolean }) =>
    Effect.gen(function* () {
      const target = yield* resolve(input);
      if (input.refresh === true) yield* pullRequests.refresh(target.key, target.accountId);
      const detail = yield* pullRequests.detail(target.key, target.accountId);
      const files = yield* pullRequests.files(target.key, target.accountId);
      const stack =
        detail.stack === null ? null : yield* pullRequests.stack(target.key, target.accountId);
      const count = (state: "passing" | "failing" | "pending") =>
        detail.checks.filter((check) => check.status === state).length;
      const result: PullRequestResult = {
        key: target.key,
        accountId: target.accountId,
        url: detail.url,
        title: detail.title,
        body: detail.body,
        state: detail.state,
        isDraft: detail.isDraft,
        author: detail.author?.login ?? null,
        headBranch: detail.headBranch,
        baseBranch: detail.baseBranch,
        headSha: detail.headSha,
        mergeability: detail.mergeability,
        reviewDecision: detail.reviewDecision,
        checks: {
          passing: count("passing"),
          failing: count("failing"),
          pending: count("pending"),
          failingNames: detail.checks
            .filter((check) => check.status === "failing")
            .map((check) => check.name),
        },
        additions: detail.additions,
        deletions: detail.deletions,
        changedFiles: detail.changedFiles,
        files: files.files.map((file) => ({
          path: file.path,
          previousPath: file.previousPath,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
        })),
        stack:
          detail.stack === null || stack === null
            ? null
            : {
                position: detail.stack.position,
                size: detail.stack.size,
                layers: stack.layers.map((layer) => ({
                  position: layer.position,
                  number: layer.number,
                  title: layer.title,
                  state: layer.state,
                })),
              },
        reviewers: detail.reviewers,
        labels: detail.labels,
        actions: detail.actions,
        fetchedAt: detail.freshness.fetchedAt,
      };
      return result;
    }).pipe(Effect.mapError(asFailure));

  const guideStatusOf = (snapshot: ReviewSnapshot): GuideStatus => {
    const review = snapshot.review;
    const attempt = snapshot.attempt;
    const running =
      review !== null && (review.status._tag === "preparing" || review.status._tag === "writing");
    return {
      key: snapshot.key,
      state: review === null ? "none" : review.status._tag,
      message:
        review === null
          ? "No guide yet. Start one with generate_guide."
          : review.status._tag === "failed"
            ? review.status.message
            : review.status._tag === "done"
              ? `Done: ${review.status.reason}.`
              : review.watchProblem,
      latestRevision: review?.latestRevision ?? null,
      agent: review === null ? null : { instance: review.instance, model: review.model },
      startedBy: attempt?.startedBy ?? null,
      progress:
        running && attempt !== null
          ? {
              narration: attempt.narration,
              filesRead: attempt.files.filter((file) => file.read === "read").length,
              files: attempt.files.length,
            }
          : null,
    };
  };

  const guide = (input: TargetInput) =>
    Effect.gen(function* () {
      const target = yield* resolve(input);
      const snapshot = yield* reviews.get(target.key);
      const revision =
        snapshot.review === null || snapshot.review.latestRevision === null
          ? null
          : forReader(
              yield* reviews.guide(target.key, undefined),
              snapshot.review.accountId,
              target.accountId,
            );
      const result: GuideResult = {
        status: guideStatusOf(snapshot),
        guide:
          revision === null
            ? null
            : {
                revision: revision.revision,
                headSha: revision.headSha,
                createdAt: revision.createdAt,
                content: revision.normalized,
                ...(yield* manualCheckTicks.numbers(
                  { _tag: "pull-request", key: target.key, accountId: target.accountId },
                  revision,
                )),
              },
      };
      return result;
    }).pipe(Effect.mapError(asFailure));

  const comments = (input: TargetInput & PageInput) =>
    Effect.gen(function* () {
      const target = yield* resolve(input);
      const drafts = yield* reviewComments.list(target.key, target.accountId);
      const threads = yield* pullRequests.threads(target.key, target.accountId);
      const files = yield* pullRequests.files(target.key, target.accountId);
      const result = {
        drafts: drafts.comments.map((comment) => {
          const placed = placeOn(comment, files);
          // Where it sits now; an outdated draft names the lines it was written on, as threads do.
          const { start, end } =
            placed._tag === "outdated" ? comment.anchor : placed.placement.anchor;
          return {
            id: comment.id,
            path: comment.anchor.path,
            side: end.side,
            startLine: start.line,
            line: end.line,
            outdated: placed._tag === "outdated",
            body: comment.body,
            state: comment.state,
          };
        }),
        threads: threads.threads.map((thread) => ({
          id: thread.id,
          path: thread.path,
          line: thread.anchor?.end.line ?? thread.originalLine,
          outdated: thread.anchor === null,
          resolved: thread.resolved,
          comments: thread.comments.map((comment) => ({
            author: comment.author?.login ?? null,
            body: comment.body,
            url: comment.url,
          })),
        })),
        threadsTruncated: threads.truncated,
      };
      const entries = [
        ...result.drafts.map((value) => ({ kind: "draft" as const, value })),
        ...result.threads.map((value) => ({ kind: "thread" as const, value })),
      ];
      const paged = yield* page(entries, input, `comments:${target.accountId}:${target.key}`);
      return {
        nextCursor: paged.nextCursor,
        total: paged.total,
        truncated: paged.truncated,
        message: paged.message,
        drafts: paged.items.flatMap((entry) => (entry.kind === "draft" ? [entry.value] : [])),
        threads: paged.items.flatMap((entry) => (entry.kind === "thread" ? [entry.value] : [])),
        threadsTruncated: result.threadsTruncated,
      };
    }).pipe(Effect.mapError(asFailure));

  const turnMessage = (turn: FixerTurn) => {
    switch (turn.status._tag) {
      case "failed":
      case "discarded":
        return turn.status.message;
      case "ready":
        return "Committed in prkit. It waits for the owner to push it from prkit.";
      case "unchanged":
        return "The agent changed nothing.";
      default:
        return null;
    }
  };

  const fixResultOf = (snapshot: FixerSnapshot, diff: FixResult["latestDiff"]): FixResult => {
    const turns = [...snapshot.turns].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const working = turns.some((turn) => WORKING_TURNS.has(turn.status._tag));
    const waiting = turns.some((turn) => turn.status._tag === "ready");
    return {
      key: snapshot.key,
      state:
        snapshot.fixer === null
          ? "none"
          : snapshot.fixer.status._tag === "done"
            ? "done"
            : working
              ? "working"
              : waiting
                ? "waiting-for-push"
                : "idle",
      turns: turns.map((turn) => ({
        id: turn.id,
        kind: turn.work._tag,
        state: turn.status._tag,
        message: turnMessage(turn),
        waitingForPush: turn.status._tag === "ready",
        startedBy: turn.startedBy,
        narration: turn.narration,
        commit:
          turn.commit === null ? null : { sha: turn.commit.sha, message: turn.commit.message },
        comments:
          turn.work._tag === "fix"
            ? turn.work.comments.map((comment) => {
                const reported =
                  turn.work._tag === "fix"
                    ? turn.work.report?.perComment.find((entry) => entry.commentId === comment.id)
                    : undefined;
                return {
                  id:
                    comment.source._tag === "draft"
                      ? comment.source.draftId
                      : comment.source.threadId,
                  path: comment.path,
                  status: reported?.status ?? null,
                  note: reported?.note ?? null,
                };
              })
            : [],
        createdAt: turn.createdAt,
      })),
      latestDiff: diff,
    };
  };

  /** The latest committed turn's diff as patch text, cut at 60,000 characters. */
  const latestDiff = (key: PullRequestKey, snapshot: FixerSnapshot) =>
    Effect.gen(function* () {
      const latest = [...snapshot.turns]
        .filter((turn) => turn.commit !== null)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      if (latest === undefined) return null;
      const diff = yield* fixers.diff(key, latest.id).pipe(Effect.option);
      if (Option.isNone(diff)) return null;
      const files = diff.value._tag === "commit" ? diff.value.diff.files : diff.value.ours.files;
      const text = files
        .map((file) =>
          file.patch._tag === "text"
            ? `--- ${file.previousPath ?? file.path}\n+++ ${file.path}\n${file.patch.patch}`
            : `${file.path}: ${file.patch._tag === "binary" ? "binary file" : "too large to show"}`,
        )
        .join("\n");
      return {
        turnId: latest.id,
        diff: text.slice(0, DIFF_LIMIT),
        cut: text.length > DIFF_LIMIT,
      };
    });

  const fix = (input: TargetInput & PageInput) =>
    Effect.gen(function* () {
      const target = yield* resolve(input);
      const snapshot = yield* fixers.history(target.key);
      const result = fixResultOf(snapshot, yield* latestDiff(target.key, snapshot));
      const paged = yield* page(
        result.turns,
        input,
        `fix:${target.key}:${result.turns.map((turn) => turn.id).join(",")}`,
      );
      return {
        ...result,
        turns: paged.items,
        nextCursor: paged.nextCursor,
        total: paged.total,
        truncated: paged.truncated,
        message: paged.message,
      };
    }).pipe(Effect.mapError(asFailure));

  /**
   * Waits on the same streams the app's views watch, so nothing reads GitHub. A timeout
   * stops the waiting, never the work.
   */
  const waitFor = (
    input: TargetInput & {
      readonly what: "guide" | "fix";
      readonly timeoutSeconds?: number;
    },
  ) =>
    Effect.gen(function* () {
      const target = yield* resolve(input);
      const timeout = `${input.timeoutSeconds ?? WAIT_DEFAULT_SECONDS} seconds` as const;
      if (input.what === "guide") {
        const start = yield* reviews.get(target.key);
        if (start.review === null)
          return yield* fail("not-found", "No guide was started for this pull request.");
        const settled = yield* reviews.watch(target.key).pipe(
          Stream.map((event) => (event._tag === "snapshot" ? event.snapshot.review : event.review)),
          Stream.filter(
            (review) =>
              review !== null &&
              review.status._tag !== "preparing" &&
              review.status._tag !== "writing",
          ),
          Stream.runHead,
          Effect.timeoutOption(timeout),
        );
        const now = yield* reviews.get(target.key);
        const result: WaitResult = {
          finished: Option.isSome(settled) && Option.isSome(settled.value),
          guide: guideStatusOf(now),
          fix: null,
        };
        return result;
      }
      const busy = (snapshot: FixerSnapshot) =>
        snapshot.turns.some((turn) => WORKING_TURNS.has(turn.status._tag));
      if ((yield* fixers.get(target.key)).fixer === null)
        return yield* fail("not-found", "Nothing was sent to the fix agent for this pull request.");
      const settled = yield* fixers.watch(target.key).pipe(
        Stream.filter((snapshot) => !busy(snapshot)),
        Stream.runHead,
        Effect.timeoutOption(timeout),
      );
      const snapshot = yield* fixers.get(target.key);
      const result: WaitResult = {
        finished: Option.isSome(settled) && Option.isSome(settled.value),
        guide: null,
        fix: fixResultOf(snapshot, yield* latestDiff(target.key, snapshot)),
      };
      return result;
    }).pipe(Effect.mapError(asFailure));

  // Work. Each is the same service call the app's own button makes.

  const open = (input: TargetInput & { readonly focus?: boolean }) =>
    Effect.gen(function* () {
      const target = yield* resolve(input);
      const focus = input.focus !== false;
      yield* workspace.command(
        {
          kind: focus ? "open" : "open-in-background",
          key: target.key,
          accountId: target.accountId,
        },
        { focus },
      );
      return yield* openPullRequests();
    }).pipe(Effect.mapError(asFailure));

  const stopGuide = (input: TargetInput) =>
    Effect.gen(function* () {
      const target = yield* resolve(input);
      return guideStatusOf(yield* reviews.stop(target.key));
    }).pipe(Effect.mapError(asFailure));

  const addComment = (
    input: TargetInput & {
      readonly path: string;
      readonly line: number;
      readonly startLine?: number;
      readonly side?: "new" | "old";
      readonly headSha: string;
      readonly body: string;
      readonly clientRequestId?: string;
    },
  ) =>
    Effect.gen(function* () {
      const target = yield* resolve(input);
      return yield* idempotent(
        {
          tool: "add_review_comment",
          clientRequestId: input.clientRequestId,
          key: target.key,
          input: [
            input.path,
            input.line,
            input.startLine ?? input.line,
            input.side ?? "new",
            input.headSha,
            input.body,
          ],
        },
        AddedComment,
        Effect.gen(function* () {
          // GitHub's head now, not a cached one, so lines read before a push are refused.
          yield* pullRequests.current(target.key, target.accountId);
          const placement = yield* placementOn(
            yield* pullRequests.files(target.key, target.accountId),
            input,
          );
          const before = new Set(
            (yield* reviewComments.list(target.key, target.accountId)).comments.map(
              (comment) => comment.id,
            ),
          );
          const after = yield* reviewComments.add(
            target.key,
            target.accountId,
            placement,
            input.body,
          );
          const added = after.comments.find((comment) => !before.has(comment.id));
          if (added === undefined)
            return yield* fail("failed", "prkit couldn't save the comment. Try again.");
          return { id: added.id, key: target.key };
        }),
      );
    }).pipe(Effect.mapError(asFailure));

  const latestTurnId = (snapshot: FixerSnapshot) =>
    [...snapshot.turns].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.id;

  const sendToFix = (input: typeof SendToFixInput.Type) =>
    Effect.gen(function* () {
      const target = yield* resolve(input);
      return yield* idempotent(
        {
          tool: "send_to_fix_agent",
          clientRequestId: input.clientRequestId,
          key: target.key,
          input: [
            // The same ids in another order are the same request.
            input.draftIds === undefined ? null : input.draftIds.toSorted().join(","),
            input.threadIds === undefined ? null : input.threadIds.toSorted().join(","),
            input.instructions ?? null,
            input.instance ?? null,
            input.model ?? null,
            input.options?.map((option) => `${option.id}=${option.value}`).join(",") ?? null,
          ],
        },
        StartedTurn,
        Effect.gen(function* () {
          const agent = yield* requestedAgent(agents, input);
          // Neither named: every draft still waiting, as Send to agent in prkit sends them.
          const draftIds =
            input.draftIds === undefined && input.threadIds === undefined
              ? (yield* reviewComments.list(target.key, target.accountId)).comments
                  .filter((comment) => comment.state === "draft")
                  .map((comment) => comment.id)
              : (input.draftIds ?? []);
          const targets: Array<FixTarget> = [
            ...draftIds.map((id): FixTarget => ({ _tag: "draft", id })),
            ...(input.threadIds ?? []).map((threadId): FixTarget => ({ _tag: "thread", threadId })),
          ];
          if (targets.length === 0)
            return yield* fail(
              "invalid",
              "There is nothing to send: no draft comments wait on this pull request. Add one with add_review_comment, or pass threadIds from list_review_comments.",
            );
          const snapshot = yield* fixers.send(target.key, target.accountId, {
            ...(agent === undefined ? {} : { agent }),
            targets,
            note: input.instructions ?? null,
            replyAfterPush: false,
          });
          const turnId = latestTurnId(snapshot);
          if (turnId === undefined)
            return yield* fail("failed", "prkit couldn't queue the fix. Try again.");
          return { key: target.key, turnId };
        }),
      );
    }).pipe(Effect.mapError(asFailure));

  const revise = (
    input: TargetInput & {
      readonly instructions: string;
      readonly turnId?: FixerTurnId;
      readonly clientRequestId?: string;
    },
  ) =>
    Effect.gen(function* () {
      const target = yield* resolve(input);
      return yield* idempotent(
        {
          tool: "ask_fix_agent_to_change",
          clientRequestId: input.clientRequestId,
          key: target.key,
          input: [input.instructions, input.turnId ?? null],
        },
        StartedTurn,
        Effect.gen(function* () {
          const snapshot = yield* fixers.get(target.key);
          const turnId =
            input.turnId ??
            [...snapshot.turns]
              .filter((turn) => turn.status._tag === "ready")
              .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.id;
          if (turnId === undefined)
            return yield* fail(
              "conflict",
              "No fix is waiting for Push, so there is nothing to change.",
            );
          yield* fixers.revise(target.key, turnId, input.instructions);
          return { key: target.key, turnId };
        }),
      );
    }).pipe(Effect.mapError(asFailure));

  const stopFix = (input: TargetInput) =>
    Effect.gen(function* () {
      const target = yield* resolve(input);
      const { snapshot, changesLeft } = yield* fixers.stopWorking(target.key);
      return {
        ...fixResultOf(snapshot, null),
        note:
          changesLeft === 0
            ? null
            : "A change you asked for is still running, on a fix that was waiting for Push. Stop it in prkit, which keeps or discards that fix.",
      };
    }).pipe(Effect.mapError(asFailure));

  const retryFix = (input: TargetInput & { readonly turnId?: FixerTurnId }) =>
    Effect.gen(function* () {
      const target = yield* resolve(input);
      const before = yield* fixers.get(target.key);
      const turnId =
        input.turnId ??
        [...before.turns]
          .filter((turn) => turn.status._tag === "failed")
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.id;
      if (turnId === undefined)
        return yield* fail("conflict", "No fix failed, so there is nothing to retry.");
      return fixResultOf(yield* fixers.retry(target.key, turnId, { refuse: ["revert"] }), null);
    }).pipe(Effect.mapError(asFailure));

  const resolveConflicts = (input: typeof ConflictsInput.Type) =>
    Effect.gen(function* () {
      const target = yield* resolve(input);
      const agent = yield* requestedAgent(agents, input);
      const snapshot = yield* fixers.resolveConflicts(target.key, target.accountId, {
        ...(agent === undefined ? {} : { agent }),
        strategy: input.strategy ?? "merge",
      });
      return fixResultOf(snapshot, null);
    }).pipe(Effect.mapError(asFailure));

  const reads = yield* makeOutsideReads(resolve, guideStatusOf);
  const actions = yield* makeOutsideActions(resolve, guideStatusOf, openPullRequests);
  const local = yield* makeOutsideLocal(idempotent);
  return {
    ...reads,
    ...actions,
    ...local,
    ...questions,
    status,
    inbox,
    openPullRequests,
    pullRequest,
    guide,
    comments,
    fix,
    waitFor,
    open,
    stopGuide,
    addComment,
    sendToFix,
    revise,
    stopFix,
    retryFix,
    resolveConflicts,
  };
});

export const layer = Layer.effect(OutsideWork, make);
