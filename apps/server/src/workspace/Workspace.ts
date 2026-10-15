import {
  applyWorkspaceCommand,
  type InboxFilters,
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

const StoredFilters = Schema.fromJsonString(SavedInboxFilters);
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
  const read = () =>
    Effect.gen(function* () {
      const open =
        yield* sql`SELECT key, account_id AS accountId, position FROM open_pull_requests ORDER BY position`;
      const rows =
        yield* sql`SELECT active_key AS activeKey, inbox_filters AS inboxFilters FROM workspace WHERE id = 1`.pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(
              Schema.Array(
                Schema.Struct({
                  activeKey: WorkspaceSchema.fields.activeKey,
                  inboxFilters: Schema.NullOr(Schema.String),
                }),
              ),
            ),
          ),
        );
      return yield* Schema.decodeUnknownEffect(WorkspaceSchema)({
        open,
        activeKey: rows[0]?.activeKey ?? null,
        inboxFilters: decodeFilters(rows[0]?.inboxFilters ?? null),
      });
    }).pipe(
      Effect.mapError(
        () =>
          new WorkspaceError({
            message: "Couldn't read your open pull requests. Retry or restart prkit.",
          }),
      ),
    );
  /**
   * Applies one change to the open PRs. A change no window asked for (an outside agent's)
   * is `announce`d, so every window shows it; `focus` asks them to show that PR.
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
            return next;
          }),
        )
        .pipe(
          Effect.tap((next) => {
            if (announce === undefined) return Effect.void;
            const focused = next.open.find((row) => row.key === next.activeKey);
            return PubSub.publish(announced, {
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
                message: "Couldn't save your open pull requests. Retry or restart prkit.",
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
      return saved;
    }).pipe(
      gate.withPermits(1),
      Effect.mapError(
        () => new WorkspaceError({ message: "Couldn't save your Inbox filters. Try again." }),
      ),
    );
  const changes = (): Stream.Stream<WorkspaceChange> => Stream.fromPubSub(announced);
  return { get: () => gate.withPermits(1)(read()), command, saveInboxFilters, changes };
});

export const layer = Layer.effect(Workspace, make);
