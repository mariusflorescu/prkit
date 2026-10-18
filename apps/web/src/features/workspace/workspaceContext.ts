import type {
  AccountId,
  LocalReviewKey,
  PullRequestKey,
  Workspace,
  WorkspaceCommand,
} from "@prkit/contracts";
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
  /** Puts a local review's tab in the strip and shows its page. */
  openLocal: (key: LocalReviewKey) => void;
  /** Takes a local review's tab out of the strip; the review stays. */
  closeLocal: (key: LocalReviewKey) => void;
  /** Puts the tab in the strip if it isn't there, for a page reached another way. */
  ensureLocal: (key: LocalReviewKey) => void;
} | null>(null);
export const useWorkspace = () => {
  const value = useContext(WorkspaceContext);
  if (value === null) throw new Error("WorkspaceProvider is missing");
  return value;
};
