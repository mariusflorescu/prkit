import type { PullRequestCommand, PullRequestStateAction } from "@prkit/contracts";
import { createContext, useContext } from "react";

type ActionEditor =
  | "merge"
  | "close"
  | "edit"
  | "labels"
  | "reviewers"
  | "update-branch"
  | "enable-auto-merge"
  | "revert"
  | "approve-workflows";
export const PullRequestActionsContext = createContext<{
  pending: boolean;
  error: Error | null;
  run: (command: PullRequestCommand) => Promise<boolean>;
  show: (kind: ActionEditor, anchor: HTMLElement) => void;
  dismiss: () => void;
} | null>(null);
export const usePullRequestActions = () => {
  const context = useContext(PullRequestActionsContext);
  if (context === null) throw new Error("PullRequestActionsProvider is missing");
  return context;
};
/** Starts a header action: one that needs no input runs at once, the rest open their form at `anchor`. */
export const useStartPullRequestAction = () => {
  const actions = usePullRequestActions();
  return (kind: PullRequestStateAction, anchor: HTMLElement) => {
    switch (kind) {
      case "ready":
      case "draft":
      case "reopen":
      case "disable-auto-merge":
        void actions.run({ kind });
        return;
      default:
        actions.show(kind, anchor);
    }
  };
};
export type { ActionEditor };
