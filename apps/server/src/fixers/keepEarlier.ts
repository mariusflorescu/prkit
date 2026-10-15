import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { SqlError } from "effect/sql/SqlError";

import { GitTampered } from "../repo/gitRun.ts";
import { LinkRefused, RepoError } from "../repo/RepoCache.ts";
import { TurnFailure } from "./fixerState.ts";

/** What a change request can fail with and still leave the earlier result as it was. */
type Recoverable = TurnFailure | RepoError | LinkRefused | GitTampered | SqlError;

const isSqlError = Schema.is(SqlError);
const isRecoverable = Schema.is(
  Schema.Union([TurnFailure, RepoError, LinkRefused, GitTampered, SqlError]),
);

/**
 * Runs a change request on a ready result. Any failure it can name, from choosing the agent
 * to committing, goes to `keepEarlier`, so a failed change never throws away the result the
 * owner already had.
 */
export const keepingEarlier = <E, R, E2, R2>(
  body: Effect.Effect<void, E | Recoverable, R>,
  keepEarlier: (message: string) => Effect.Effect<void, E2, R2>,
) =>
  body.pipe(
    Effect.catchIf(isRecoverable, (error) =>
      keepEarlier(isSqlError(error) ? "prkit couldn't save the change request." : error.message),
    ),
  );
