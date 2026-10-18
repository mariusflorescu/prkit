import {
  applyWorkspaceCommand,
  refFromKey,
  type Workspace,
  WorkspaceCommand,
} from "@prkit/contracts";
import type { Mutation, QueryClient } from "@tanstack/react-query";
import * as Schema from "effect/Schema";

import { workspaceQuery } from "~/rpc/queries";

export const workspaceMutationKey = ["workspace-change"];
const isCommand = Schema.is(WorkspaceCommand);

/** A pending change's command; every mutation under the workspace key sends one. */
export const commandOf = (mutation: Mutation) => {
  const variables = mutation.state.variables;
  return isCommand(variables) ? [variables] : [];
};

/** The tabs as this window shows them: the server's newest copy with its unsaved changes on top. */
export const shownWorkspace = (
  confirmed: Workspace | undefined,
  pending: ReadonlyArray<WorkspaceCommand>,
) => (confirmed === undefined ? undefined : pending.reduce(applyWorkspaceCommand, confirmed));

/** The same, read now: for handlers that run outside a render. */
export const currentWorkspace = (client: QueryClient) =>
  shownWorkspace(
    client.getQueryData(workspaceQuery.queryKey),
    client
      .getMutationCache()
      .findAll({ mutationKey: workspaceMutationKey, status: "pending" })
      .flatMap(commandOf),
  );

/** The open PR whose page `pathname` is, if any. */
export const shownPullRequest = (workspace: Workspace | undefined, pathname: string) =>
  workspace?.open.find((row) => {
    const ref = refFromKey(row.key);
    return ref !== null && pathname === `/pr/${ref.host}/${ref.owner}/${ref.repo}/${ref.number}`;
  });
