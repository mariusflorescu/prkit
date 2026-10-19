import {
  AUTO_RESOLVE_LIMIT,
  type ConflictReport,
  FIXER_BUSY,
  FixerError,
  type FixerFeedEvent,
  type FixerId,
  type FixerSnapshot,
  type FixerTurnId,
  type FixerTurnState,
  type FixerTurnStatus,
  type FixReport,
  type PullRequestKey,
  type PullRequestRef,
  refFromKey,
} from "@prkit/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import {
  decodeActivity,
  decodeEachTurn,
  decodeFixers,
  decodeTurns,
  encodeStatus,
  type FixerRow,
  readableFixers,
  toActivity,
  toFixer,
  toTurn,
  TURN_COLUMNS,
} from "./fixerRows.ts";
import { FixerSettingsStore } from "./FixerSettingsStore.ts";
import { decideTurn, type TurnCommand } from "./turnRules.ts";

/** Ends a turn as `failed(reason)`. */
export class TurnFailure extends Schema.TaggedError<TurnFailure>()("TurnFailure", {
  reason: Schema.Literals([
    "interrupted",
    "account",
    "github",
    "repository",
    "agent-auth",
    "agent",
    "no-report",
    "checks",
    "push",
  ]),
  message: Schema.String,
}) {}

export const decodeCount = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ count: Schema.Int })),
);

export const short = (sha: string) => sha.slice(0, 7);
export const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
/** One line, trimmed and cut to `max` characters. */
export const clip = (text: string, max: number) => {
  const line = text.replaceAll(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};
export const repositoryOf = (ref: PullRequestRef) => `${ref.host}/${ref.owner}/${ref.repo}`;

/** What the turn running now must report on before it ends. */
export type Awaiting =
  | { readonly _tag: "fix" }
  | { readonly _tag: "conflicts"; readonly files: ReadonlyArray<string> };

export type Notice = Extract<FixerFeedEvent, { _tag: "notice" }>;

export const reportSummary = (report: FixReport | ConflictReport | null) => {
  if (report === null) return "ready to review";
  if ("perComment" in report) {
    const counts = (status: string) =>
      report.perComment.filter((entry) => entry.status === status).length;
    return [
      counts("fixed") > 0 && `${counts("fixed")} fixed`,
      counts("partly") > 0 && `${counts("partly")} partly`,
      counts("skipped") > 0 && `${counts("skipped")} skipped`,
    ]
      .filter(Boolean)
      .join(", ");
  }
  return plural(report.perFile.length, "file");
};

/**
 * What every part of the fix agent shares: the rows, compare-and-set on a turn's
 * state, the activity log, and the change and notice streams.
 */
export const makeFixerState = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const settings = yield* FixerSettingsStore;

  const contextDir = path.join(config.home, "fix-context");
  yield* fs.makeDirectory(contextDir, { recursive: true });
  /** Names this server run; startup only interrupts turns other runs left unfinished. */
  const runId = yield* crypto.randomUUIDv4;
  const awaiting = new Map<FixerTurnId, Awaiting>();
  const changes = yield* PubSub.unbounded<PullRequestKey>();
  const notices = yield* PubSub.unbounded<Notice>();
  const titles = new Map<PullRequestKey, string>();

  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  // The OS random source failing is not something a fix can recover from.
  const newId = crypto.randomUUIDv4.pipe(Effect.orDie);
  const publish = (key: PullRequestKey) => PubSub.publish(changes, key).pipe(Effect.asVoid);
  const fail = (reason: TurnFailure["reason"], message: string) =>
    Effect.fail(new TurnFailure({ reason, message }));

  const findFixer = (key: PullRequestKey) =>
    sql`SELECT * FROM fixers WHERE pr_key = ${key}`.pipe(
      Effect.flatMap(decodeFixers),
      Effect.map((rows) => rows[0] ?? null),
    );
  const fixerById = (id: FixerId) =>
    sql`SELECT * FROM fixers WHERE id = ${id}`.pipe(
      Effect.flatMap(decodeFixers),
      Effect.map((rows) => rows[0] ?? null),
    );
  const turnById = (id: FixerTurnId) =>
    sql`SELECT ${sql.literal(TURN_COLUMNS)} FROM fixer_turns WHERE id = ${id}`.pipe(
      Effect.flatMap(decodeTurns),
      Effect.map((rows) => rows[0] ?? null),
    );
  const turnsOf = (fixerId: FixerId, states: ReadonlyArray<FixerTurnState>) =>
    sql`SELECT ${sql.literal(TURN_COLUMNS)} FROM fixer_turns
      WHERE fixer_id = ${fixerId} AND json_extract(status, '$._tag') IN ${sql.in(states)}
      ORDER BY created_at, rowid`.pipe(Effect.flatMap(decodeTurns));

  const settingsOf = (key: PullRequestKey) => {
    const ref = refFromKey(key);
    return ref === null
      ? Effect.succeed({
          repository: key,
          pushAutomatically: false,
          resolveAutomatically: false,
          runScriptsOnAnyPullRequest: false,
        })
      : settings.get(repositoryOf(ref));
  };

  /** Conflict turns started without a click in the last day, per PR. */
  const autoResolvedToday = (fixerId: FixerId) =>
    sql`SELECT COUNT(*) AS count FROM fixer_turns WHERE fixer_id = ${fixerId} AND kind = 'conflicts'
      AND trigger = 'auto' AND created_at >= ${DateTime.formatIso(DateTime.subtract(DateTime.nowUnsafe(), { days: 1 }))}`.pipe(
      Effect.flatMap(decodeCount),
      Effect.map((rows) => rows[0]?.count ?? 0),
    );
  const autoResolvesLeft = (fixerId: FixerId) =>
    autoResolvedToday(fixerId).pipe(Effect.map((count) => count < AUTO_RESOLVE_LIMIT));

  const snapshotOf = (key: PullRequestKey, history = false) =>
    Effect.gen(function* () {
      const row = yield* findFixer(key);
      const repositorySettings = yield* settingsOf(key);
      if (row === null)
        return {
          key,
          fixer: null,
          turns: [],
          activity: [],
          settings: repositorySettings,
          autoResolvePaused: false,
        } satisfies FixerSnapshot;
      const turns = yield* sql`SELECT ${sql.literal(TURN_COLUMNS)} FROM fixer_turns
        WHERE fixer_id = ${row.id} ORDER BY created_at DESC, rowid DESC ${history ? sql`` : sql`LIMIT 20`}`.pipe(
        Effect.flatMap(decodeTurns),
      );
      const current = turns.find((turn) => turn.status._tag !== "queued");
      const activity =
        current === undefined
          ? []
          : yield* sql`
            SELECT id, turn_id, at, kind, text, detail FROM (
              SELECT * FROM fixer_activity WHERE turn_id = ${current.id} ORDER BY id DESC LIMIT 80
            ) ORDER BY id`.pipe(Effect.flatMap(decodeActivity));
      return {
        key,
        fixer: toFixer(row),
        turns: turns.map(toTurn),
        activity: activity.map(toActivity),
        settings: repositorySettings,
        autoResolvePaused:
          repositorySettings.resolveAutomatically && !(yield* autoResolvesLeft(row.id)),
      } satisfies FixerSnapshot;
    });

  const appendActivity = (
    key: PullRequestKey,
    turnId: FixerTurnId,
    kind: "phase" | "tool" | "note" | "error",
    text: string,
    detail: string | null = null,
  ) =>
    Effect.gen(function* () {
      const at = yield* now;
      yield* sql`INSERT INTO fixer_activity (turn_id, at, kind, text, detail)
        VALUES (${turnId}, ${at}, ${kind}, ${text}, ${detail})`;
      yield* publish(key);
    });

  /** Compare-and-set on the turn's state: a late write from a turn that moved on changes nothing. */
  const transition = (
    turnId: FixerTurnId,
    from: ReadonlyArray<FixerTurnState>,
    status: FixerTurnStatus,
    /** Only a turn no change request ever ran on (`rounds = 0`). */
    freshOnly = false,
  ) =>
    Effect.gen(function* () {
      const at = yield* now;
      const ends = !FIXER_BUSY.includes(status._tag) && status._tag !== "queued";
      const rows = yield* sql`
        UPDATE fixer_turns SET status = ${encodeStatus(status)},
          finished_at = CASE WHEN ${ends ? 1 : 0} = 1 THEN ${at} ELSE finished_at END
        WHERE id = ${turnId} AND json_extract(status, '$._tag') IN ${sql.in(from)}
          AND (${freshOnly ? 1 : 0} = 0 OR rounds = 0) RETURNING id`;
      return rows.length > 0;
    });

  /** Drafts a turn held go back to being the owner's drafts. */
  const returnDrafts = (turnId: FixerTurnId) =>
    Effect.gen(function* () {
      const at = yield* now;
      yield* sql`UPDATE pending_comments SET state = 'draft', fixer_turn_id = NULL, updated_at = ${at}
        WHERE fixer_turn_id = ${turnId} AND state = 'sent-to-agent'`;
    });

  const notify = (fixer: FixerRow, title: string, body: string) => {
    const notice: Notice = {
      _tag: "notice",
      key: fixer.pr_key,
      accountId: fixer.account_id,
      title,
      body: `${titles.get(fixer.pr_key) ?? fixer.pr_key} · ${body}`,
    };
    return PubSub.publish(notices, notice).pipe(Effect.asVoid);
  };

  const dbFailures = {
    SqlError: () =>
      Effect.fail(new FixerError({ message: "prkit couldn't read or save the fix. Try again." })),
    SchemaError: () =>
      Effect.fail(new FixerError({ message: "prkit read a damaged fix record. Try again." })),
  };

  /** The turn a command names, checked to belong to the PR it came with. */
  const commandTurn = (key: PullRequestKey, turnId: FixerTurnId, command: TurnCommand) =>
    Effect.gen(function* () {
      const row = yield* turnById(turnId);
      const fixer = row === null ? null : yield* fixerById(row.fixer_id);
      if (row === null || fixer === null || fixer.pr_key !== key)
        return yield* new FixerError({ message: "This fix is no longer there. Refresh." });
      return { row, fixer, outcome: decideTurn(command, toTurn(row)) };
    });

  const turnActivity = (key: PullRequestKey, turnId: FixerTurnId) =>
    Effect.gen(function* () {
      yield* commandTurn(key, turnId, "push");
      return (yield* sql`SELECT * FROM fixer_activity WHERE turn_id = ${turnId} ORDER BY id`.pipe(
        Effect.flatMap(decodeActivity),
      )).map(toActivity);
    });

  /** Unfinished turns prkit can't read: their agent may still be in the checkout. */
  const unreadableTurns = (fixerId: FixerId) =>
    sql`SELECT ${sql.literal(TURN_COLUMNS)} FROM fixer_turns
      WHERE fixer_id = ${fixerId} AND finished_at IS NULL`.pipe(
      Effect.flatMap(decodeEachTurn),
      Effect.map(([, unreadable]) => unreadable),
    );

  /** Every active fixer, with its PR's account, for the watcher. */
  const watched = sql`SELECT * FROM fixers WHERE ended IS NULL`.pipe(
    Effect.flatMap(readableFixers),
  );

  return {
    contextDir,
    runId,
    awaiting,
    changes,
    notices,
    titles,
    now,
    newId,
    publish,
    fail,
    findFixer,
    fixerById,
    turnById,
    turnsOf,
    autoResolvesLeft,
    snapshotOf,
    appendActivity,
    transition,
    returnDrafts,
    notify,
    dbFailures,
    commandTurn,
    turnActivity,
    unreadableTurns,
    watched,
  };
});

export type FixerState = Effect.Success<typeof makeFixerState>;
