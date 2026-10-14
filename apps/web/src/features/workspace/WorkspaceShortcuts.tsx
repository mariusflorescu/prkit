import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";

import { composerFor, useStartGuide } from "~/components/review";
import { isSettingsPath } from "~/features/settings/settingsSections";

import { shortcutFor } from "./shortcuts";
import { useWorkspaceSession } from "./sessionStore";
import { useWorkspace } from "./workspaceContext";

/** Runs the shortcuts in `shortcuts.ts`: that table says which keys, this says what they do. */
export function WorkspaceShortcuts() {
  const workspace = useWorkspace();
  const navigate = useNavigate();
  const path = useRouterState({ select: (state) => state.location.pathname });
  const guide = useStartGuide();
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.isComposing || event.altKey || event.repeat || event.defaultPrevented) return;
      const id = shortcutFor(event);
      if (id === undefined) return;
      const session = useWorkspaceSession.getState();
      const rows = workspace.data?.open ?? [];
      const onPullRequest = path.startsWith("/pr/");
      const onSettings = isSettingsPath(path);
      // The strip in order: Inbox, the PR tabs, then Settings when it is open.
      const strip = [
        "inbox" as const,
        ...rows.map((row) => row.key),
        ...(session.settingsTab.open || onSettings ? ["settings" as const] : []),
      ];
      const select = (tab: (typeof strip)[number] | undefined) => {
        if (tab === "inbox") void navigate({ to: "/" });
        else if (tab === "settings") workspace.openSettings();
        else if (tab !== undefined) workspace.activate(tab);
      };
      const cycle = (direction: 1 | -1) => {
        const index = onSettings
          ? strip.length - 1
          : onPullRequest
            ? rows.findIndex((row) => row.key === workspace.data?.activeKey) + 1
            : 0;
        select(strip[(index + direction + strip.length) % strip.length]);
      };
      switch (id) {
        case "settings":
          event.preventDefault();
          workspace.openSettings();
          return;
        case "palette":
          event.preventDefault();
          session.setPaletteOpen(!session.paletteOpen, "all");
          return;
        case "openPullRequest":
          event.preventDefault();
          session.setPaletteOpen(true, "open-pr");
          return;
        case "writeGuide": {
          // The open guide setup's choices, else the default agent; either way, on a PR.
          const active = workspace.data?.open.find((row) => row.key === workspace.data?.activeKey);
          if (!onPullRequest || active === undefined || session.paletteOpen) return;
          event.preventDefault();
          const submit = composerFor(active.key);
          if (submit === undefined) guide.start(active.key, active.accountId, true);
          else submit();
          return;
        }
        case "closeTab":
          event.preventDefault();
          if (session.paletteOpen) return;
          if (onSettings) workspace.closeSettings();
          else if (onPullRequest && workspace.data?.activeKey)
            workspace.close(workspace.data.activeKey);
          return;
        case "reopenTab":
          if (session.paletteOpen) return;
          event.preventDefault();
          workspace.reopen();
          return;
        case "inbox":
        case "selectPullRequest":
          // Numbers count the Inbox and PR tabs only; Settings has Cmd+, instead.
          if (session.paletteOpen) return;
          event.preventDefault();
          select(Number(event.key) === 1 ? "inbox" : rows[Number(event.key) - 2]?.key);
          return;
        case "nextTab":
          if (session.paletteOpen) return;
          event.preventDefault();
          cycle(1);
          return;
        case "previousTab":
          if (session.paletteOpen) return;
          event.preventDefault();
          cycle(-1);
          return;
        default: {
          const unhandled: never = id;
          return unhandled;
        }
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [workspace, navigate, path, guide]);
  return null;
}
