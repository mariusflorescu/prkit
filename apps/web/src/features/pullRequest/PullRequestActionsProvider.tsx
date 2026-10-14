import { Popover } from "@base-ui/react/popover";
import { pullRequestKey, type PullRequestCommand, type PullRequestDetail } from "@prkit/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { createStore, useStore } from "zustand";

import { toastManager } from "~/components/ui/toast";
import { useWorkspace } from "~/features/workspace/workspaceContext";
import { invalidatePullRequestReads } from "~/features/github/pullRequestReads";
import { executePullRequest } from "~/rpc/client";
import { inboxQuery } from "~/rpc/queries";
import { PullRequestActionsContext, type ActionEditor } from "./actionContext";
import { PullRequestActionForm } from "./PullRequestActionForm";
import { PullRequestEditForm } from "./PullRequestEditForm";
import { PullRequestMetadataPicker } from "./PullRequestMetadataPicker";

type Editor = { kind: ActionEditor; anchor: HTMLElement; detail: PullRequestDetail } | null;

export function PullRequestActionsProvider({
  detail,
  children,
}: {
  detail: PullRequestDetail;
  children: ReactNode;
}) {
  const client = useQueryClient();
  const workspace = useWorkspace();
  const locked = useRef(false);
  const [editorStore] = useState(() =>
    createStore<{ editor: Editor; setEditor: (editor: Editor) => void }>((set) => ({
      editor: null,
      setEditor: (editor) => set({ editor }),
    })),
  );
  const editor = useStore(editorStore, (state) => state.editor);
  const setEditor = useStore(editorStore, (state) => state.setEditor);
  const action = useMutation({
    mutationKey: ["pullRequestAction", detail.accountId, detail.key],
    mutationFn: (command: PullRequestCommand) =>
      executePullRequest(detail.key, detail.accountId, command),
    retry: false,
    onSuccess: (result) => {
      toastManager.add({
        type: result.warning === null ? "success" : "warning",
        title: result.message,
        ...(result.warning === null ? {} : { description: result.warning }),
      });
      if (result.url !== null) {
        const created = new URL(result.url);
        const [, owner, repo, pull, number] = created.pathname.split("/");
        if (owner && repo && pull === "pull" && number && Number.isSafeInteger(Number(number)))
          workspace.open(
            pullRequestKey({ host: created.hostname, owner, repo, number: Number(number) }),
            detail.accountId,
          );
      }
    },
    onError: (error) =>
      toastManager.add({
        type: "error",
        title: "Pull request action failed",
        description: error.message,
      }),
    // The server marked this PR and its account's inbox stale when the action ran.
    onSettled: () =>
      Promise.all([
        invalidatePullRequestReads(client, detail.key, detail.accountId),
        client.invalidateQueries({ queryKey: inboxQuery.queryKey }),
      ]),
  });
  const run = useCallback(
    async (command: PullRequestCommand) => {
      if (locked.current) return false;
      locked.current = true;
      try {
        await action.mutateAsync(command);
        setEditor(null);
        return true;
      } catch {
        return false;
      } finally {
        locked.current = false;
      }
    },
    [action, setEditor],
  );
  const dismiss = useCallback(() => {
    if (!action.isPending) {
      setEditor(null);
      action.reset();
    }
  }, [action, setEditor]);
  const show = useCallback(
    (kind: ActionEditor, anchor: HTMLElement) => {
      action.reset();
      setEditor({ kind, anchor, detail });
    },
    [action, detail, setEditor],
  );
  const value = useMemo(
    () => ({ pending: action.isPending, error: action.error, run, show, dismiss }),
    [action.isPending, action.error, run, show, dismiss],
  );
  return (
    <PullRequestActionsContext.Provider value={value}>
      {children}
      <Popover.Root
        open={editor !== null}
        onOpenChange={(open) => {
          if (!open) dismiss();
        }}
      >
        <Popover.Portal>
          <Popover.Positioner
            anchor={editor?.anchor ?? undefined}
            align="end"
            sideOffset={8}
            className="z-50"
          >
            <Popover.Popup
              aria-label={
                editor?.kind === "edit"
                  ? "Edit pull request"
                  : editor?.kind === "labels"
                    ? "Set labels"
                    : editor?.kind === "reviewers"
                      ? "Request reviewers"
                      : "Confirm pull request action"
              }
              className="w-96 max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-popover p-4 text-popover-foreground shadow-lg"
            >
              {editor?.kind === "edit" ? (
                <PullRequestEditForm key={detail.key} detail={editor.detail} />
              ) : editor?.kind === "labels" || editor?.kind === "reviewers" ? (
                <PullRequestMetadataPicker
                  key={`${detail.key}:${editor.kind}`}
                  detail={editor.detail}
                  kind={editor.kind}
                />
              ) : editor !== null ? (
                <PullRequestActionForm
                  key={`${detail.key}:${editor.kind}`}
                  detail={editor.detail}
                  kind={editor.kind}
                />
              ) : null}
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </PullRequestActionsContext.Provider>
  );
}
