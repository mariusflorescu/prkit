import type { AccountId, PullRequestKey, Workspace, WorkspaceCommand } from "@prkit/contracts";
import { createContext, useContext } from "react";

export const WorkspaceContext = createContext<{
  data: Workspace | undefined;
  pending: boolean;
  error: Error | null;
  retry: () => void;
  open: (key: PullRequestKey, accountId: AccountId) => void;
  activate: (key: PullRequestKey) => void;
  close: (key: PullRequestKey) => void;
  closeMany: (keys: readonly PullRequestKey[]) => void;
  reopen: () => void;
  openSettings: () => void;
  closeSettings: () => void;
  send: (command: WorkspaceCommand) => void;
  ensure: (key: PullRequestKey, accountId: AccountId) => void;
} | null>(null);
export const useWorkspace = () => {
  const value = useContext(WorkspaceContext);
  if (value === null) throw new Error("WorkspaceProvider is missing");
  return value;
};
