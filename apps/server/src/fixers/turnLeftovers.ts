import { type FixerId, FixerTurnId } from "@prkit/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import {
  endTurn,
  type ProcessHost,
  type TurnProcess,
  turnRecord,
  Unfinished,
} from "../agents/turnEnd.ts";
import { TurnFailure } from "./fixerState.ts";

const LeftoverRow = Schema.Struct({
  id: FixerTurnId,
  started_at: Schema.NullOr(Schema.String),
  created_at: Schema.String,
  unfinished_end: Schema.fromJsonString(Unfinished),
});
const decodeLeftovers = Schema.decodeUnknownEffect(Schema.Array(LeftoverRow));
const encodeUnfinished = Schema.encodeSync(Schema.fromJsonString(Unfinished));

/** Why a fix stopped at Needs you when something its agent started may still be running. */
export const unfinishedMessage = (reason: string) =>
  `prkit stopped and needs you: it couldn't make sure that everything the agent started has ended (${reason}). Nothing was committed or pushed. Retry to run the agent again.`;

/** When a turn started, in epoch milliseconds. */
export const turnSince = (row: {
  readonly started_at: string | null;
  readonly created_at: string;
}) =>
  DateTime.make(row.started_at ?? row.created_at).pipe(
    Option.map(DateTime.toEpochMillis),
    Option.getOrElse(() => 0),
  );

/**
 * What agent turns may have left running (docs/internals/fix-agent.md "Turn end"). A turn
 * whose end prkit couldn't make sure of keeps why, and what prkit tied to it; prkit runs none
 * of its own git in that fixer's checkout until a later look ends it all.
 */
export const makeTurnLeftovers = (host: ProcessHost) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    /** Ends what prkit can tie to a turn: what it tied before, and what carries the turn's mark. */
    const sweep = (
      turnId: FixerTurnId,
      since: number,
      processes: ReadonlyArray<TurnProcess> = [],
    ) => endTurn(host, turnRecord(turnId, since, processes), process.pid);

    const record = (turnId: FixerTurnId, end: Unfinished) =>
      sql`UPDATE fixer_turns SET unfinished_end = ${encodeUnfinished(end)} WHERE id = ${turnId}`.pipe(
        Effect.asVoid,
      );

    /** The fixer's turns whose end prkit couldn't make sure of yet. */
    const pending = (fixerId: FixerId) =>
      sql`SELECT id, started_at, created_at, unfinished_end FROM fixer_turns
        WHERE fixer_id = ${fixerId} AND unfinished_end IS NOT NULL
        ORDER BY created_at, rowid`.pipe(Effect.flatMap(decodeLeftovers));

    /**
     * Before a turn runs any git: ends again what earlier turns left, and refuses to start
     * while any of them still can't finish.
     */
    const settle = (fixerId: FixerId) =>
      Effect.gen(function* () {
        for (const row of yield* pending(fixerId)) {
          const end = yield* sweep(row.id, turnSince(row), row.unfinished_end.processes);
          if (end._tag === "unfinished") {
            yield* record(row.id, end);
            return yield* new TurnFailure({
              reason: "checks",
              message: unfinishedMessage(end.reason),
            });
          }
          yield* sql`UPDATE fixer_turns SET unfinished_end = NULL WHERE id = ${row.id}`;
          yield* Effect.logInfo("An earlier agent turn has ended").pipe(
            Effect.annotateLogs({ turnId: row.id }),
          );
        }
      });

    /** Runs one of prkit's git steps in the checkout, unless an agent turn may still run there. */
    const unlessLeftovers = <E>(fixerId: FixerId, step: Effect.Effect<void, E>) =>
      Effect.gen(function* () {
        if ((yield* pending(fixerId)).length > 0)
          return yield* Effect.logWarning(
            "Left the fix's checkout as it was: an agent turn may still be running there",
          ).pipe(Effect.annotateLogs({ fixerId }));
        yield* step;
      });

    return { sweep, record, pending, settle, unlessLeftovers };
  });

export type TurnLeftovers = Effect.Success<ReturnType<typeof makeTurnLeftovers>>;
