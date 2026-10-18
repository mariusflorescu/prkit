import {
  applyWorkspaceCommand,
  DEFAULT_INBOX_SORT,
  type InboxFilters,
  InboxSort,
  NO_INBOX_FILTERS,
  refFromKey,
  SavedInboxFilters,
  Workspace as WorkspaceSchema,
  type WorkspaceChange,
  WorkspaceError,
  type WorkspaceCommand,
} from "@prkit/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

/** Filters saved before the sort existed keep their search and selections, and sort by recent activity. */
const StoredFilters = Schema.fromJsonString(
  Schema.Struct({
    ...SavedInboxFilters.fields,
    sort: InboxSort.pipe(Schema.withDecodingDefaultKey(Effect.succeed(DEFAULT_INBOX_SORT))),
  }),
);
const UNSAVED: SavedInboxFilters = { ...NO_INBOX_FILTERS, savedAt: null };
/** Saved filters that don't decode start the Inbox unfiltered rather than fail the open tabs' read. */
const decodeFilters = (stored: string | null) =>
  stored === null
    ? UNSAVED
    : Option.getOrElse(Schema.decodeOption(StoredFilters)(stored), () => UNSAVED);

export class Workspace extends Context.Service<Workspace, Effect.Success<typeof make>>()(
  "@prkit/server/workspace/Workspace",
) {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const gate = yield* Semaphore.make(1);
  /** Changes made other than through a window's own RPC, which windows apply as they come. */
  const announced = yield* PubSub.unbounded<WorkspaceChange>();
  // One transaction, so a review's removal can't land between reading its tab and the version.
  const read = () =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const open =
            yield* sql`SELECT key, account_id AS accountId, position FROM open_pull_requests ORDER BY position`;
          const local = yield* sql`SELECT key, position FROM open_local_reviews ORDER BY position`;
          const rows =
            yield* sql`SELECT active_key AS activeKey, inbox_filters AS inboxFilters, version FROM workspace WHERE id = 1`.pipe(
              Effect.flatMap(
                Schema.decodeUnknownEffect(
                  Schema.Array(
                    Schema.Struct({
                      activeKey: WorkspaceSchema.fields.activeKey,
                      inboxFilters: Schema.NullOr(Schema.String),
                      version: Schema.Int,
                    }),
                  ),
                ),
              ),
            );
          return yield* Schema.decodeUnknownEffect(WorkspaceSchema)({
            open,
            local,
            activeKey: rows[0]?.activeKey ?? null,
            inboxFilters: decodeFilters(rows[0]?.inboxFilters ?? null),
            version: rows[0]?.version ?? 0,
          });
        }),
      )
      .pipe(
        Effect.mapError(
          () =>
            new WorkspaceError({
              message: "Couldn't read your open tabs. Retry or restart prkit.",
            }),
        ),
      );
  /**
   * Applies one change to the open PRs or local reviews. A change no window asked for (an
   * outside agent's) is `announce`d, so every window shows it; `focus` asks them to show that
   * PR. A local review's tab never takes focus, and removing the review drops its row.
   */
  const command = (input: WorkspaceCommand, announce?: { readonly focus: boolean }) =>
    gate.withPermits(1)(
      sql
        .withTransaction(
          Effect.gen(function* () {
            const current = yield* read();
            if (input.kind === "open") {
              const ref = refFromKey(input.key);
              if (!ref || !input.accountId.startsWith(`${ref.host}/`))
                return yield* new WorkspaceError({
                  message: "This pull request and GitHub account must belong to the same host.",
                });
            }
            if (
              input.kind === "open-local" &&
              (yield* sql`SELECT 1 FROM reviews WHERE pr_key = ${input.key} AND local IS NOT NULL`)
                .length === 0
            )
              return yield* new WorkspaceError({
                message:
                  "This local review was removed. Run `prkit local guide` in its folder for a new one.",
              });
            if (input.kind === "activate" && !current.open.some((row) => row.key === input.key))
              return yield* new WorkspaceError({
                message: "This pull request is no longer open. Open it again from the inbox.",
              });
            if (
              input.kind === "reorder" &&
              (input.keys.length !== current.open.length ||
                new Set(input.keys).size !== current.open.length ||
                input.keys.some((key) => !current.open.some((row) => row.key === key)))
            )
              return yield* new WorkspaceError({
                message: "The open list changed. Retry with the current list.",
              });
            const next = applyWorkspaceCommand(current, input);
            yield* sql`UPDATE workspace SET active_key = NULL WHERE id = 1`;
            yield* sql`DELETE FROM open_pull_requests`;
            for (const row of next.open)
              yield* sql`INSERT INTO open_pull_requests (key, account_id, position) VALUES (${row.key}, ${row.accountId}, ${row.position})`;
            yield* sql`UPDATE workspace SET active_key = ${next.activeKey} WHERE id = 1`;
            if (next.local !== current.local) {
              yield* sql`DELETE FROM open_local_reviews`;
              for (const row of next.local)
                yield* sql`INSERT INTO open_local_reviews (key, position) VALUES (${row.key}, ${row.position})`;
            }
            return yield* read();
          }),
        )
        .pipe(
          Effect.tap((next) => {
            if (announce === undefined) return Effect.void;
            const focused = next.open.find((row) => row.key === next.activeKey);
            return PubSub.publish(announced, {
              _tag: "changed",
              workspace: next,
              focus:
                announce.focus &&
                (input.kind === "open" || input.kind === "activate") &&
                focused !== undefined
                  ? { key: focused.key, accountId: focused.accountId }
                  : null,
            });
          }),
        )
        .pipe(
          Effect.catchTag("SqlError", () =>
            Effect.fail(
              new WorkspaceError({
                message: "Couldn't save your open tabs. Retry or restart prkit.",
              }),
            ),
          ),
        ),
    );
  const saveInboxFilters = (filters: InboxFilters) =>
    Effect.gen(function* () {
      const saved = { ...filters, savedAt: DateTime.formatIso(yield* DateTime.now) };
      const stored = yield* Schema.encodeEffect(StoredFilters)(saved);
      yield* sql`UPDATE workspace SET inbox_filters = ${stored} WHERE id = 1`;
      return { filters: saved, workspace: yield* read() };
    }).pipe(
      gate.withPermits(1),
      Effect.mapError(
        () => new WorkspaceError({ message: "Couldn't save your Inbox filters. Try again." }),
      ),
    );
  /**
   * Open while a window is: the tabs as they are, then each change made elsewhere. Commands
   * announce under the gate, so nothing older than the first message follows it.
   */
  const changes = (): Stream.Stream<WorkspaceChange, WorkspaceError> =>
    Stream.unwrap(
      gate.withPermits(1)(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(announced);
          const current: WorkspaceChange = { _tag: "current", workspace: yield* read() };
          return Stream.concat(Stream.succeed(current), Stream.fromSubscription(subscription));
        }),
      ),
    );
  return { get: () => gate.withPermits(1)(read()), command, saveInboxFilters, changes };
});

export const layer = Layer.effect(Workspace, make);
