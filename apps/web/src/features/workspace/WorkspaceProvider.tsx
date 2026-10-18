import {
  applyWorkspaceCommand,
  type LocalReviewKey,
  type OpenPullRequest,
  refFromKey,
  type WorkspaceCommand,
} from "@prkit/contracts";
import { useMutation, useMutationState, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef, type ReactNode } from "react";

import { changeWorkspace } from "~/rpc/client";
import { workspaceQuery } from "~/rpc/queries";
import { isSettingsPath } from "~/features/settings/settingsSections";
import { desktopBridge } from "~/lib/desktop";

import { useWorkspaceSession } from "./sessionStore";
import { useWorkspaceChanges } from "./useWorkspaceChanges";
import { WorkspaceContext } from "./workspaceContext";
import {
  commandOf,
  currentWorkspace,
  shownPullRequest,
  shownWorkspace,
  workspaceMutationKey,
} from "./workspaceView";

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const query = useQuery(workspaceQuery);
  const pending = useMutationState({
    filters: { mutationKey: workspaceMutationKey, status: "pending" },
    select: commandOf,
  }).flat();
  const data = shownWorkspace(query.data, pending);
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const shownLocal = useParams({ strict: false }).key;
  const restore = useRef(pathname === "/");
  // A change shows at once, as a pending command on the server's copy, until the server's saved
  // tabs replace that copy, or it fails and drops out.
  const mutation = useMutation({
    mutationKey: workspaceMutationKey,
    scope: { id: "workspace" },
    mutationFn: changeWorkspace,
    onSuccess: (saved) => client.setQueryData(workspaceQuery.queryKey, saved),
    onError: (error, command) => {
      useWorkspaceSession.setState({ failed: { command, message: error.message } });
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
  const send = (command: WorkspaceCommand) => {
    const before = currentWorkspace(client);
    if (before) {
      if (command.kind === "close") {
        const row = before.open.find((row) => row.key === command.key);
        if (row) useWorkspaceSession.getState().rememberClosed(row);
      }
      if (command.kind === "close-local" && before.local.some((row) => row.key === command.key))
        useWorkspaceSession.getState().rememberClosed({ local: command.key });
    }
    useWorkspaceSession.setState({ failed: null });
    mutation.mutate(command);
  };
  useWorkspaceChanges({ show: go, send });
  // The PR on screen left the strip, whatever took it (an outside agent, or this window's change
  // settling after one): show the active one instead, else the Inbox. Its own close navigates.
  const lastShown = useRef(data);
  useEffect(() => {
    const previous = lastShown.current;
    lastShown.current = data;
    if (previous === undefined || data === undefined) return;
    const onScreen = shownPullRequest(previous, pathname);
    if (
      onScreen === undefined ||
      data.open.some((row) => row.key === onScreen.key) ||
      pending.some((command) => command.kind === "close" && command.key === onScreen.key)
    )
      return;
    go(data.open.find((row) => row.key === data.activeKey) ?? null);
  });
  const current = () => currentWorkspace(client);
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
  const showLocal = (key: LocalReviewKey) => {
    useWorkspaceSession.getState().setPaletteOpen(false);
    void navigate({ to: "/local/$key", params: { key } });
  };
  const openLocal = (key: LocalReviewKey) => {
    if (!current()?.local.some((row) => row.key === key)) send({ kind: "open-local", key });
    showLocal(key);
  };
  // Closing the local review on screen shows the local tab that takes its place, else the
  // active PR, else the Inbox.
  const closeLocal = (key: LocalReviewKey) => {
    const before = current();
    if (before?.local.some((row) => row.key === key)) send({ kind: "close-local", key });
    if (shownLocal !== key) return;
    const index = before?.local.findIndex((row) => row.key === key) ?? -1;
    const rest = before?.local.filter((row) => row.key !== key) ?? [];
    const next = index < 0 ? undefined : rest[Math.min(index, rest.length - 1)];
    if (next) return showLocal(next.key);
    go(before?.open.find((row) => row.key === before.activeKey) ?? null);
  };
  const closeMany = (keys: readonly OpenPullRequest["key"][]) => {
    const before = current();
    if (!before) return;
    const next = keys.reduce(
      (state, key) => applyWorkspaceCommand(state, { kind: "close", key }),
      before,
    );
    for (const key of keys) send({ kind: "close", key });
    const onScreen = shownPullRequest(before, pathname);
    if (onScreen === undefined || !keys.includes(onScreen.key)) return;
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
        returnKey: from.startsWith("/pr/") ? (currentWorkspace(client)?.activeKey ?? null) : null,
      });
    else if (!session.settingsTab.open) session.setSettingsTab({ open: true });
  }, [pathname, client]);
  useEffect(() => {
    if (query.isPending || !restore.current) return;
    restore.current = false;
    const active = data?.open.find((row) => row.key === data.activeKey);
    if (pathname === "/" && active) go(active);
  });
  return (
    <WorkspaceContext
      value={{
        data,
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
              : "local" in tab
                ? !current()?.local.some((row) => row.key === tab.local)
                : !current()?.open.some((row) => row.key === tab.key),
          );
          const last = session.closed[index];
          useWorkspaceSession.setState({ closed: session.closed.slice(0, Math.max(index, 0)) });
          if (!last) return;
          if (last === "settings") return openSettings();
          if ("local" in last) return openLocal(last.local);
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
        openLocal,
        closeLocal,
        ensureLocal: (key) => {
          const workspace = current();
          if (workspace && !workspace.local.some((row) => row.key === key))
            send({ kind: "open-local", key });
        },
      }}
    >
      {children}
    </WorkspaceContext>
  );
}
