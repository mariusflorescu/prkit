import type { AccountId, PullRequestKey, PullRequestState } from "@prkit/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { ManualCheckTicks } from "../manualCheck/ManualCheckTicks.ts";
import { ReviewedFiles } from "../reviewedFiles/ReviewedFiles.ts";
import { subjectFromKey, subjectKey } from "../reviews/reviewSubject.ts";
import { Workspace } from "../workspace/Workspace.ts";

/** A pull request through the account that reads it. */
export type ReadingTarget = { readonly key: PullRequestKey; readonly accountId: AccountId };

/**
 * What GitHub said about a pull request in the watcher's current pass: its state, or `lost` when
 * it no longer shows the PR to its account (lost access, a deleted repository) or prkit no longer
 * has the account.
 */
export type PullRequestRead = ReadingTarget & {
  readonly answer: typeof PullRequestState.Type | "lost";
};

/**
 * How long a PR stays lost before its reading state goes. Reading it costs a fiftieth of a
 * GraphQL point every 15 minutes, while forgetting too soon loses the reader's marks for good,
 * and a month outlasts a holiday, an organization's sign-in left for later and an account taken
 * out and added back.
 */
const LOST_DAYS = 30;

const decodeSubjects = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ subject: Schema.String })),
);

const READING_SUBJECTS =
  "SELECT subject FROM reviewed_files UNION SELECT subject FROM manual_check_ticks";

/**
 * A pull request's reviewed files and checked manual check steps, kept until GitHub says it
 * was merged or closed and no tab shows it (docs/internals/architecture.md "Reviewed files").
 */
export class ReadingState extends Context.Service<ReadingState, Effect.Success<typeof make>>()(
  "@prkit/server/readingState/ReadingState",
) {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const workspace = yield* Workspace;
  const reviewedFiles = yield* ReviewedFiles;
  const manualCheckTicks = yield* ManualCheckTicks;

  const skipped =
    <A>(message: string, fallback: A) =>
    (error: { readonly message: string }) =>
      Effect.logWarning(message).pipe(
        Effect.annotateLogs({ error: error.message }),
        Effect.as(fallback),
      );

  /**
   * The pull requests with something marked that no tab shows. A tab counts by the key alone,
   * like the guard in `forget`: one opened through another account still keeps the marks.
   */
  const unshown = Effect.gen(function* () {
    const shown = new Set((yield* workspace.get()).open.map((row) => row.key));
    const rows = yield* sql`
      SELECT subject FROM reviewed_files UNION SELECT subject FROM manual_check_ticks`.pipe(
      Effect.flatMap(decodeSubjects),
    );
    const found: Array<ReadingTarget> = [];
    for (const row of rows) {
      const subject = subjectFromKey(row.subject);
      if (subject?._tag === "pull-request" && !shown.has(subject.key))
        found.push({ key: subject.key, accountId: subject.accountId });
    }
    return found;
  }).pipe(
    Effect.catchTags({
      WorkspaceError: skipped("Couldn't read the open tabs", []),
      SqlError: skipped("Couldn't list the pull requests with something marked", []),
      SchemaError: skipped("Couldn't list the pull requests with something marked", []),
    }),
  );

  /**
   * Drops what was read on a PR, unless a tab shows it by the time this runs. The rows go with
   * plain SQL: a decision's own gate is taken before its transaction, so using it from inside
   * this one would take the two in the opposite order.
   */
  const forget = ({ key, accountId }: ReadingTarget) =>
    Effect.gen(function* () {
      const subject = subjectKey({ _tag: "pull-request", key, accountId });
      const files = yield* sql`
        DELETE FROM reviewed_files
        WHERE subject = ${subject} AND NOT EXISTS (SELECT 1 FROM open_pull_requests WHERE key = ${key})
        RETURNING subject`;
      const steps = yield* sql`
        DELETE FROM manual_check_ticks
        WHERE subject = ${subject} AND NOT EXISTS (SELECT 1 FROM open_pull_requests WHERE key = ${key})
        RETURNING subject`;
      return { key, accountId, files: files.length > 0, steps: steps.length > 0 };
    });

  /**
   * Whether the PR's reading state is due to go, by this pass: merged or closed, or lost for a
   * month. A lost PR with reading state is noted with when that started, and one GitHub answers
   * for again is no longer lost.
   */
  const due = (
    read: PullRequestRead,
    lost: ReadonlySet<string>,
    { at, cutoff }: { readonly at: string; readonly cutoff: string },
  ) =>
    Effect.gen(function* () {
      const subject = subjectKey({
        _tag: "pull-request",
        key: read.key,
        accountId: read.accountId,
      });
      if (read.answer !== "lost") {
        if (lost.has(subject))
          yield* sql`DELETE FROM lost_pull_requests WHERE subject = ${subject}`;
        return read.answer !== "open";
      }
      yield* sql`
        INSERT INTO lost_pull_requests (subject, since)
        SELECT ${subject}, ${at} WHERE ${subject} IN (${sql.literal(READING_SUBJECTS)})
        ON CONFLICT (subject) DO NOTHING`;
      const lostLong = yield* sql`
        SELECT 1 FROM lost_pull_requests WHERE subject = ${subject} AND since <= ${cutoff}`;
      return lostLong.length > 0;
    });

  /**
   * Forgets what was read on every PR this pass found merged, closed or lost for a month. Only
   * what GitHub said now counts: the status the server remembers is set by fingerprints alone, so
   * it can still say closed for a PR that has been reopened since. Windows are told right after
   * the commit, and the commit and the telling are one uninterruptible step.
   */
  const settle = (reads: ReadonlyArray<PullRequestRead>) => {
    if (reads.length === 0) return Effect.void;
    return Effect.gen(function* () {
      const now = yield* DateTime.now;
      const times = {
        at: DateTime.formatIso(now),
        cutoff: DateTime.formatIso(DateTime.subtract(now, { days: LOST_DAYS })),
      };
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const lost = new Set(
            (yield* sql`SELECT subject FROM lost_pull_requests`.pipe(
              Effect.flatMap(decodeSubjects),
            )).map((row) => row.subject),
          );
          const results = yield* Effect.forEach(reads, (read) =>
            due(read, lost, times).pipe(
              Effect.flatMap((ended) => (ended ? forget(read) : Effect.succeed(null))),
            ),
          );
          if (lost.size > 0 || reads.some((read) => read.answer === "lost"))
            yield* sql`DELETE FROM lost_pull_requests
              WHERE subject NOT IN (${sql.literal(READING_SUBJECTS)})`;
          return results.filter((result) => result !== null);
        }),
      );
    }).pipe(
      Effect.flatMap((results) =>
        Effect.gen(function* () {
          const forgotten = results.filter((result) => result.files || result.steps);
          for (const { key, accountId, files, steps } of forgotten) {
            if (files) yield* reviewedFiles.announceChanged({ key, accountId });
            if (steps)
              yield* manualCheckTicks.announceChanged({ _tag: "pull-request", key, accountId });
          }
          if (forgotten.length > 0)
            yield* Effect.logInfo("Forgot what was read on pull requests that ended").pipe(
              Effect.annotateLogs({ pullRequests: forgotten.length }),
            );
        }),
      ),
      Effect.uninterruptible,
      Effect.catchTag(
        "SqlError",
        skipped("Couldn't forget what was read on pull requests that ended", undefined),
      ),
    );
  };

  return { unshown, settle };
});

export const layer = Layer.effect(ReadingState, make);
