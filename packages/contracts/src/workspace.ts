import * as Schema from "effect/Schema";

import { AccountId, LocalReviewKey, PullRequestKey } from "./ids.ts";
import { PullRequestRef } from "./inbox.ts";
import { DEFAULT_INBOX_SORT, InboxSort } from "./inboxTriage.ts";

export const OpenPullRequest = Schema.Struct({
  key: PullRequestKey,
  accountId: AccountId,
  position: Schema.Int,
});
export type OpenPullRequest = typeof OpenPullRequest.Type;
/** A local review's tab, after the PR tabs. It is never the server's active tab. */
export const OpenLocalReview = Schema.Struct({ key: LocalReviewKey, position: Schema.Int });
export type OpenLocalReview = typeof OpenLocalReview.Type;
/** The repository the Inbox shows; its open pull requests are read through the first account. */
export const RepositoryFilter = Schema.Struct({
  host: Schema.String,
  owner: Schema.String,
  name: Schema.String,
  accountIds: Schema.NonEmptyArray(AccountId),
});
export type RepositoryFilter = typeof RepositoryFilter.Type;
/** The Inbox's search and filters; `null` shows every account or repository. */
export const InboxFilters = Schema.Struct({
  search: Schema.String,
  account: Schema.NullOr(AccountId),
  repository: Schema.NullOr(RepositoryFilter),
  sort: InboxSort,
});
export type InboxFilters = typeof InboxFilters.Type;
export const NO_INBOX_FILTERS: InboxFilters = {
  search: "",
  account: null,
  repository: null,
  sort: DEFAULT_INBOX_SORT,
};
/** The Inbox's filters as the server keeps them; `savedAt` is null until the user sets one. */
export const SavedInboxFilters = Schema.Struct({
  ...InboxFilters.fields,
  savedAt: Schema.NullOr(Schema.String),
});
export type SavedInboxFilters = typeof SavedInboxFilters.Type;
export const Workspace = Schema.Struct({
  open: Schema.Array(OpenPullRequest),
  local: Schema.Array(OpenLocalReview),
  activeKey: Schema.NullOr(PullRequestKey),
  inboxFilters: SavedInboxFilters,
});
export type Workspace = typeof Workspace.Type;
/** A change to the open PRs made elsewhere; `focus` asks the window to show that PR and come forward. */
export const WorkspaceChange = Schema.Struct({
  workspace: Workspace,
  focus: Schema.NullOr(Schema.Struct({ key: PullRequestKey, accountId: AccountId })),
});
export type WorkspaceChange = typeof WorkspaceChange.Type;
export const WorkspaceCommand = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("open"), key: PullRequestKey, accountId: AccountId }),
  Schema.Struct({ kind: Schema.Literal("close"), key: PullRequestKey }),
  Schema.Struct({ kind: Schema.Literal("activate"), key: PullRequestKey }),
  Schema.Struct({ kind: Schema.Literal("reorder"), keys: Schema.Array(PullRequestKey) }),
  Schema.Struct({ kind: Schema.Literal("open-local"), key: LocalReviewKey }),
  Schema.Struct({ kind: Schema.Literal("close-local"), key: LocalReviewKey }),
]);
export type WorkspaceCommand = typeof WorkspaceCommand.Type;
export class WorkspaceError extends Schema.TaggedError<WorkspaceError>()("WorkspaceError", {
  message: Schema.String,
}) {}

export const refFromKey = (key: PullRequestKey) => {
  const match = /^([^/]+)\/([^/]+)\/([^/#]+)#([1-9]\d*)$/.exec(key);
  if (!match) return null;
  const [, host, owner, repo, number] = match;
  if (!host || !owner || !repo || !number) return null;
  const ref = { host, owner, repo, number: Number(number) };
  return Schema.is(PullRequestRef)(ref) ? ref : null;
};

export const applyWorkspaceCommand = (current: Workspace, command: WorkspaceCommand): Workspace => {
  switch (command.kind) {
    case "open":
      return {
        ...current,
        open: current.open.some((row) => row.key === command.key)
          ? current.open
          : [
              ...current.open,
              { key: command.key, accountId: command.accountId, position: current.open.length },
            ],
        activeKey: command.key,
      };
    case "activate":
      return current.open.some((row) => row.key === command.key)
        ? { ...current, activeKey: command.key }
        : current;
    case "close": {
      const index = current.open.findIndex((row) => row.key === command.key);
      const open = current.open
        .filter((row) => row.key !== command.key)
        .map((row, position) => ({ key: row.key, accountId: row.accountId, position }));
      return {
        ...current,
        open,
        activeKey:
          current.activeKey === command.key
            ? (open[Math.min(index, open.length - 1)]?.key ?? null)
            : current.activeKey,
      };
    }
    case "reorder": {
      const rows = new Map(current.open.map((row) => [row.key, row]));
      if (
        command.keys.length !== rows.size ||
        new Set(command.keys).size !== rows.size ||
        command.keys.some((key) => !rows.has(key))
      )
        return current;
      return {
        ...current,
        open: command.keys.flatMap((key, position) => {
          const row = rows.get(key);
          return row ? [{ ...row, position }] : [];
        }),
      };
    }
    case "open-local":
      return current.local.some((row) => row.key === command.key)
        ? current
        : {
            ...current,
            // After the last one: removing a review drops its row without renumbering the rest.
            local: [
              ...current.local,
              {
                key: command.key,
                position: Math.max(-1, ...current.local.map((row) => row.position)) + 1,
              },
            ],
          };
    case "close-local":
      return current.local.some((row) => row.key === command.key)
        ? {
            ...current,
            local: current.local
              .filter((row) => row.key !== command.key)
              .map((row, position) => ({ key: row.key, position })),
          }
        : current;
  }
};
