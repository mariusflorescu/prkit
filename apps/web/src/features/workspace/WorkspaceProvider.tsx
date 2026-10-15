import {
  applyWorkspaceCommand,
  type OpenPullRequest,
  refFromKey,
  type WorkspaceCommand,
} from "@prkit/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef, type ReactNode } from "react";

import { changeWorkspace } from "~/rpc/client";
import { workspaceQuery } from "~/rpc/queries";
import { isSettingsPath } from "~/features/settings/settingsSections";
import { desktopBridge } from "~/lib/desktop";

import { useWorkspaceSession } from "./sessionStore";
import { useWorkspaceChanges } from "./useWorkspaceChanges";
import { WorkspaceContext } from "./workspaceContext";

const mutationKey = ["workspace-change"];
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const query = useQuery(workspaceQuery);
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const restore = useRef(pathname === "/");
  const mutation = useMutation({
    mutationKey,
    scope: { id: "workspace" },
    mutationFn: changeWorkspace,
    onError: (error, command) =>
      useWorkspaceSession.setState({ failed: { command, message: error.message } }),
    onSettled: () => {
      if (client.isMutating({ mutationKey }) === 1)
        return client.invalidateQueries({ queryKey: workspaceQuery.queryKey });
    },
  });
  const go = (row: OpenPullRequest | null) => {
    if (row === null) {
      void navigate({ to: "/" });
      return;
    }
    const ref = refFromKey(row.key);
    if (!ref) return;
    const tab = useWorkspaceSession.getState().views[row.key]?.tab ?? "conversation";
    void navigate({
      to: "/pr/$host/$owner/$repo/$number",
      params: { host: ref.host, owner: ref.owner, repo: ref.repo, number: String(ref.number) },
      search: { account: row.accountId, tab },
    });
  };
  useWorkspaceChanges(go);
  const send = (command: WorkspaceCommand) => {
    void client.cancelQueries({ queryKey: workspaceQuery.queryKey });
    const before = client.getQueryData(workspaceQuery.queryKey);
    if (before) {
      client.setQueryData(workspaceQuery.queryKey, applyWorkspaceCommand(before, command));
      if (command.kind === "close") {
        const row = before.open.find((row) => row.key === command.key);
        if (row) useWorkspaceSession.getState().rememberClosed(row);
      }
    }
    useWorkspaceSession.setState({ failed: null });
    mutation.mutate(command);
  };
  const current = () => client.getQueryData(workspaceQuery.queryKey);
  const activate = (key: OpenPullRequest["key"]) => {
    const row = current()?.open.find((row) => row.key === key);
    if (!row) return;
    send({ kind: "activate", key });
    go(row);
  };
  // Opens the Settings tab, or focuses it: the section used last, which the /settings route picks.
  const openSettings = () => {
    useWorkspaceSession.getState().setPaletteOpen(false);
    if (!isSettingsPath(pathname)) void navigate({ to: "/settings" });
  };
  // Takes Settings out of the strip. If it was showing, goes back to the tab it was opened from.
  const closeSettings = () => {
    const session = useWorkspaceSession.getState();
    if (!session.settingsTab.open && !isSettingsPath(pathname)) return;
    session.setSettingsTab({ open: false });
    session.rememberClosed("settings");
    if (!isSettingsPath(pathname)) return;
    const row = current()?.open.find((row) => row.key === session.settingsTab.returnKey);
    if (row) activate(row.key);
    else void navigate({ to: "/" });
  };
  const closeMany = (keys: readonly OpenPullRequest["key"][]) => {
    const before = current();
    if (!before) return;
    const next = keys.reduce(
      (state, key) => applyWorkspaceCommand(state, { kind: "close", key }),
      before,
    );
    for (const key of keys) send({ kind: "close", key });
    if (!before.activeKey || !keys.includes(before.activeKey) || !pathname.startsWith("/pr/"))
      return;
    const active = next.open.find((row) => row.key === next.activeKey);
    if (active) go(active);
    else void navigate({ to: "/" });
  };
  useEffect(() => desktopBridge?.onOpenSettings(openSettings));
  // Every way into Settings (its tab, Cmd+, the menu, the palette, a link) puts the tab in the
  // strip and remembers the tab it came from.
  const previous = useRef(pathname);
  useEffect(() => {
    const from = previous.current;
    previous.current = pathname;
    if (!isSettingsPath(pathname)) return;
    const session = useWorkspaceSession.getState();
    if (!isSettingsPath(from))
      session.setSettingsTab({
        open: true,
        returnKey: from.startsWith("/pr/")
          ? (client.getQueryData(workspaceQuery.queryKey)?.activeKey ?? null)
          : null,
      });
    else if (!session.settingsTab.open) session.setSettingsTab({ open: true });
  }, [pathname, client]);
  useEffect(() => {
    if (query.isPending || !restore.current) return;
    restore.current = false;
    const active = query.data?.open.find((row) => row.key === query.data?.activeKey);
    if (pathname === "/" && active) go(active);
  });
  return (
    <WorkspaceContext
      value={{
        data: query.data,
        pending: query.isPending,
        error: query.error,
        retry: () => void query.refetch(),
        send,
        open: (key, accountId) => {
          const existing = current()?.open.find((row) => row.key === key);
          send({ kind: "open", key, accountId });
          go(existing ?? { key, accountId, position: current()?.open.length ?? 0 });
        },
        activate,
        close: (key) => closeMany([key]),
        closeMany,
        reopen: () => {
          const session = useWorkspaceSession.getState();
          // A tab opened again since it closed is skipped, so one press always brings one back.
          const index = session.closed.findLastIndex((tab) =>
            tab === "settings"
              ? !session.settingsTab.open && !isSettingsPath(pathname)
              : !current()?.open.some((row) => row.key === tab.key),
          );
          const last = session.closed[index];
          useWorkspaceSession.setState({ closed: session.closed.slice(0, Math.max(index, 0)) });
          if (!last) return;
          if (last === "settings") return openSettings();
          send({ kind: "open", key: last.key, accountId: last.accountId });
          go(last);
        },
        openSettings,
        closeSettings,
        ensure: (key, accountId) => {
          const workspace = current();
          if (!workspace) return;
          const existing = workspace.open.find((row) => row.key === key);
          if (!existing) send({ kind: "open", key, accountId });
          else {
            if (workspace.activeKey !== key) send({ kind: "activate", key });
            if (existing.accountId !== accountId) go(existing);
          }
        },
      }}
    >
      {children}
    </WorkspaceContext>
  );
}
