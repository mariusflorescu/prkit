import type { AccountId, PullRequestKey, PullRequestState } from "@prkit/contracts";
import * as Context from "effect/Context";
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

/** What GitHub said about a pull request in the watcher's current pass. */
export type PullRequestRead = ReadingTarget & { readonly state: typeof PullRequestState.Type };

const decodeSubjects = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ subject: Schema.String })),
);

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
   * Forgets what was read on every PR this pass found merged or closed. Only what GitHub
   * said now counts: the status the server remembers is set by fingerprints alone, so it can
   * still say closed for a PR that has been reopened since. Windows are told right after the
   * commit, and the commit and the telling are one uninterruptible step.
   */
  const settle = (reads: ReadonlyArray<PullRequestRead>) => {
    const ended = reads.filter((read) => read.state !== "open");
    if (ended.length === 0) return Effect.void;
    return sql.withTransaction(Effect.forEach(ended, forget)).pipe(
      Effect.flatMap((results) =>
        Effect.gen(function* () {
          const forgotten = results.filter((result) => result.files || result.steps);
          for (const { key, accountId, files, steps } of forgotten) {
            if (files) yield* reviewedFiles.announceChanged({ key, accountId });
            if (steps)
              yield* manualCheckTicks.announceChanged({ _tag: "pull-request", key, accountId });
          }
          if (forgotten.length > 0)
            yield* Effect.logInfo("Forgot what was read on merged or closed pull requests").pipe(
              Effect.annotateLogs({ pullRequests: forgotten.length }),
            );
        }),
      ),
      Effect.uninterruptible,
      Effect.catchTag(
        "SqlError",
        skipped("Couldn't forget what was read on merged or closed pull requests", undefined),
      ),
    );
  };

  return { unshown, settle };
});

export const layer = Layer.effect(ReadingState, make);
