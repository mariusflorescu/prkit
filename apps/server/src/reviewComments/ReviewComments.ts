import {
  type AccountId,
  anchorHolds,
  type CommentPlacement,
  diffRows,
  FileSide,
  NoteKey,
  type PendingComment,
  PendingCommentState,
  type PullRequestKey,
  refFromKey,
  ReviewCommentId,
  ReviewCommentsError,
  type ReviewEvent,
} from "@prkit/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { GitHubApi } from "../github/GitHubApi.ts";
import { makeKeyedGate } from "../github/keyedGate.ts";
import { PullRequests } from "../pullRequests/PullRequests.ts";

const Row = Schema.Struct({
  id: ReviewCommentId,
  pr_key: Schema.String,
  account_id: Schema.String,
  path: Schema.String,
  start_side: FileSide,
  start_line: Schema.Int,
  end_side: FileSide,
  end_line: Schema.Int,
  snippet: Schema.String,
  commit_sha: Schema.String,
  body: Schema.String,
  state: PendingCommentState,
  submission_id: Schema.NullOr(Schema.String),
  note_key: Schema.NullOr(NoteKey),
  created_at: Schema.String,
  updated_at: Schema.String,
});
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Row));
const Submission = Schema.Struct({
  id: Schema.String,
  event: Schema.Literals(["comment", "approve", "request-changes"]),
  body: Schema.String,
  started_at: Schema.String,
});
const decodeSubmissions = Schema.decodeUnknownEffect(Schema.Array(Submission));
const PostedReview = Schema.Struct({ id: Schema.Int, html_url: Schema.String });
const GitHubReview = Schema.Struct({
  id: Schema.Int,
  html_url: Schema.String,
  user: Schema.NullOr(Schema.Struct({ login: Schema.String })),
  body: Schema.NullOr(Schema.String),
  state: Schema.String,
  submitted_at: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

const EVENTS = {
  comment: { request: "COMMENT", state: "COMMENTED" },
  approve: { request: "APPROVE", state: "APPROVED" },
  "request-changes": { request: "REQUEST_CHANGES", state: "CHANGES_REQUESTED" },
} as const satisfies Record<ReviewEvent, { request: string; state: string }>;
const GITHUB_SIDE = { old: "LEFT", new: "RIGHT" } as const;
/** How far before a submission started GitHub's clock may put the review it created. */
const CLOCK_SKEW_MS = 10 * 60_000;

const anchorOf = (row: typeof Row.Type) => ({
  path: row.path,
  start: { side: row.start_side, line: row.start_line },
  end: { side: row.end_side, line: row.end_line },
});

const toComment = (row: typeof Row.Type): PendingComment => ({
  id: row.id,
  anchor: anchorOf(row),
  snippet: row.snippet,
  commitSha: row.commit_sha,
  body: row.body,
  state: row.state,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toGitHubComment = (comment: PendingComment) => {
  const { path, start, end } = comment.anchor;
  const single = start.side === end.side && start.line === end.line;
  return {
    path,
    body: comment.body,
    line: end.line,
    side: GITHUB_SIDE[end.side],
    ...(single ? {} : { start_line: start.line, start_side: GITHUB_SIDE[start.side] }),
  };
};

export class ReviewComments extends Context.Service<ReviewComments, Effect.Success<typeof make>>()(
  "@prkit/server/reviewComments/ReviewComments",
) {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const pullRequests = yield* PullRequests;
  const api = yield* GitHubApi;
  const crypto = yield* Crypto.Crypto;
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const newId = crypto.randomUUIDv4.pipe(Effect.orDie);
  /** One writer per PR and account: drafts, submissions and their reconciliation. */
  const withReview = makeKeyedGate<string>(1);
  const gate =
    (key: string, accountId: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      withReview(`${accountId}:${key}`, effect);
  const fail = (message: string) => Effect.fail(new ReviewCommentsError({ message }));
  const storage = <A, R>(
    self: Effect.Effect<A, ReviewCommentsError | Schema.SchemaError | SqlError, R>,
  ) =>
    self.pipe(
      Effect.catchTags({
        SqlError: () => fail("Couldn't save your review comments. Retry or restart prkit."),
        SchemaError: () => fail("Couldn't read your review comments. Retry or restart prkit."),
      }),
    );

  const read = (key: string, accountId: string) =>
    // Published drafts live on GitHub now, and resolved ones in the Fixes tab; a note
    // still says what became of the draft it made.
    sql`SELECT * FROM pending_comments WHERE pr_key = ${key} AND account_id = ${accountId} AND (state IN ('draft', 'sent-to-agent') OR note_key IS NOT NULL) ORDER BY created_at, id`.pipe(
      Effect.flatMap(decodeRows),
      Effect.map((rows) => ({
        comments: rows
          .filter((row) => row.state === "draft" || row.state === "sent-to-agent")
          .map(toComment),
        fromNotes: rows.flatMap((row) =>
          row.note_key === null
            ? []
            : [
                {
                  note: row.note_key,
                  id: row.id,
                  state: row.state,
                  anchor: anchorOf(row),
                  snippet: row.snippet,
                },
              ],
        ),
      })),
    );

  const finish = (submission: string, review: typeof PostedReview.Type) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const at = yield* now;
        yield* sql`UPDATE review_submissions SET github_review_id = ${review.id}, url = ${review.html_url} WHERE id = ${submission}`;
        yield* sql`UPDATE pending_comments SET state = 'published', updated_at = ${at} WHERE submission_id = ${submission}`;
      }),
    );
  const abandon = (submission: string) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`UPDATE pending_comments SET submission_id = NULL WHERE submission_id = ${submission} AND state = 'draft'`;
        yield* sql`DELETE FROM review_submissions WHERE id = ${submission}`;
      }),
    );

  /**
   * A submission still unanswered when its gate is free was cut off by a crash. GitHub
   * either took it or not: its drafts are published if the account's reviews show it,
   * and offered again otherwise. Runs under the PR's gate.
   */
  const reconcile = (key: PullRequestKey, accountId: AccountId) =>
    Effect.gen(function* () {
      const stale =
        yield* sql`SELECT id, event, body, started_at FROM review_submissions WHERE pr_key = ${key} AND account_id = ${accountId} AND github_review_id IS NULL`.pipe(
          Effect.flatMap(decodeSubmissions),
        );
      if (stale.length === 0) return;
      const ref = refFromKey(key);
      if (ref === null) return;
      const login = accountId.slice(accountId.indexOf("/") + 1);
      const reviews: Array<typeof GitHubReview.Type> = [];
      for (let page = 1; page <= 10; page++) {
        const rows = yield* api.rest(
          accountId,
          `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/pulls/${ref.number}/reviews?per_page=100&page=${page}`,
          Schema.Array(GitHubReview),
        );
        reviews.push(...rows);
        if (rows.length < 100) break;
      }
      for (const submission of stale) {
        const since = Date.parse(submission.started_at) - CLOCK_SKEW_MS;
        const posted = reviews.find(
          (review) =>
            review.user?.login === login &&
            review.state === EVENTS[submission.event].state &&
            (review.body ?? "") === submission.body &&
            Date.parse(review.submitted_at ?? "") >= since,
        );
        yield* posted === undefined ? abandon(submission.id) : finish(submission.id, posted);
        yield* Effect.logInfo("Reconciled an interrupted review submission").pipe(
          Effect.annotateLogs({ key, accountId, posted: posted !== undefined }),
        );
      }
    });

  const list = (key: PullRequestKey, accountId: AccountId) =>
    gate(
      key,
      accountId,
    )(
      reconcile(key, accountId).pipe(
        Effect.catchTag("GitHubRequestError", (error) =>
          Effect.logWarning("Couldn't reconcile a review submission yet").pipe(
            Effect.annotateLogs({ key, accountId, reason: error.reason }),
          ),
        ),
        Effect.andThen(read(key, accountId)),
        storage,
      ),
    );

  const add = (
    key: PullRequestKey,
    accountId: AccountId,
    placement: CommentPlacement,
    body: string,
  ) =>
    gate(
      key,
      accountId,
    )(
      Effect.gen(function* () {
        const ref = refFromKey(key);
        if (ref === null || !accountId.startsWith(`${ref.host}/`))
          return yield* fail("This pull request and GitHub account must belong to the same host.");
        const at = yield* now;
        const { anchor } = placement;
        yield* sql`INSERT INTO pending_comments (id, pr_key, account_id, path, start_side, start_line, end_side, end_line, snippet, commit_sha, body, state, submission_id, created_at, updated_at)
          VALUES (${yield* newId}, ${key}, ${accountId}, ${anchor.path}, ${anchor.start.side}, ${anchor.start.line}, ${anchor.end.side}, ${anchor.end.line}, ${placement.snippet}, ${placement.commitSha}, ${body}, 'draft', NULL, ${at}, ${at})`;
        return yield* read(key, accountId);
      }).pipe(storage),
    );

  /** Changes one draft that no submission has taken yet. */
  const changeDraft = <A>(
    id: ReviewCommentId,
    change: (at: string) => Effect.Effect<A, SqlError>,
  ) =>
    Effect.gen(function* () {
      const rows = yield* sql`SELECT * FROM pending_comments WHERE id = ${id}`.pipe(
        Effect.flatMap(decodeRows),
      );
      const row = rows[0];
      if (row === undefined)
        return yield* fail("This comment no longer exists. Refresh and retry.");
      return yield* gate(
        row.pr_key,
        row.account_id,
      )(
        Effect.gen(function* () {
          // Read again under the gate: a submission may have taken it meanwhile.
          const current = (yield* sql`SELECT * FROM pending_comments WHERE id = ${id}`.pipe(
            Effect.flatMap(decodeRows),
          ))[0];
          if (current?.state === "sent-to-agent")
            return yield* fail("This comment is with the agent. Discard its fix to change it.");
          if (current?.state !== "draft" || current.submission_id !== null)
            return yield* fail("This comment was already sent with a review.");
          yield* change(yield* now);
          return yield* read(row.pr_key, row.account_id);
        }),
      );
    }).pipe(storage);
  const edit = (id: ReviewCommentId, body: string) =>
    changeDraft(
      id,
      (at) => sql`UPDATE pending_comments SET body = ${body}, updated_at = ${at} WHERE id = ${id}`,
    );
  const move = (id: ReviewCommentId, placement: CommentPlacement) =>
    changeDraft(id, (at) => {
      const { anchor } = placement;
      return sql`UPDATE pending_comments SET path = ${anchor.path}, start_side = ${anchor.start.side}, start_line = ${anchor.start.line}, end_side = ${anchor.end.side}, end_line = ${anchor.end.line}, snippet = ${placement.snippet}, commit_sha = ${placement.commitSha}, updated_at = ${at} WHERE id = ${id}`;
    });
  const remove = (id: ReviewCommentId) =>
    changeDraft(id, () => sql`DELETE FROM pending_comments WHERE id = ${id}`);

  /**
   * Finishes the review on GitHub: one review with every draft whose lines are
   * still in the PR's current diff. Drafts whose lines moved stay drafts.
   */
  const submit = (key: PullRequestKey, accountId: AccountId, event: ReviewEvent, body: string) =>
    gate(
      key,
      accountId,
    )(
      Effect.gen(function* () {
        yield* reconcile(key, accountId);
        const drafts = (yield* read(key, accountId)).comments.filter(
          (comment) => comment.state === "draft",
        );
        // The review goes on the head GitHub has now, not the one a cache last saw.
        yield* pullRequests.current(key, accountId);
        const files = yield* pullRequests.files(key, accountId);
        const rows = new Map(
          files.files.map((file) => [
            file.path,
            file.patch._tag === "text" ? diffRows(file.patch.patch) : [],
          ]),
        );
        const current = drafts.filter((comment) =>
          anchorHolds(rows.get(comment.anchor.path) ?? [], comment.anchor, comment.snippet),
        );
        const outdated = drafts.length - current.length;
        if (event !== "approve" && current.length === 0 && body.trim().length === 0)
          return yield* fail(
            outdated > 0
              ? "Every draft is on lines that changed. Move or delete them, or write a summary."
              : "Write a summary or add a comment to the diff first.",
          );
        const ref = refFromKey(key);
        if (ref === null) return yield* fail("This pull request key is not valid.");
        const submission = yield* newId;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO review_submissions (id, pr_key, account_id, event, body, commit_sha, started_at)
              VALUES (${submission}, ${key}, ${accountId}, ${event}, ${body}, ${files.headSha}, ${yield* now})`;
            for (const comment of current)
              yield* sql`UPDATE pending_comments SET submission_id = ${submission} WHERE id = ${comment.id}`;
          }),
        );
        // Once the request leaves, its outcome is recorded even if the caller goes away.
        const review = yield* Effect.uninterruptible(
          api
            .restWrite(
              accountId,
              "POST",
              `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/pulls/${ref.number}/reviews`,
              PostedReview,
              {
                commit_id: files.headSha,
                event: EVENTS[event].request,
                body,
                comments: current.map(toGitHubComment),
              },
            )
            .pipe(
              Effect.tap((posted) => finish(submission, posted)),
              Effect.onError(() => abandon(submission).pipe(Effect.ignore)),
            ),
        );
        yield* pullRequests.invalidate(key, accountId);
        yield* Effect.logInfo("Review submitted").pipe(
          Effect.annotateLogs({ key, accountId, event, posted: current.length, outdated }),
        );
        return { url: review.html_url, posted: current.length, outdated };
      }).pipe(
        Effect.catchTags({
          GitHubRequestError: (error) => fail(error.message),
          PullRequestReadError: (error) => fail(error.message),
        }),
        storage,
      ),
    );

  return { list, add, edit, move, remove, submit };
});

export const layer = Layer.effect(ReviewComments, make);
