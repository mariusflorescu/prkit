import { Outlet } from "@tanstack/react-router";

import { GuideNotifications } from "~/components/review";
import { WorkspaceTabs } from "~/components/tabs/WorkspaceTabs";
import { ToastProvider } from "~/components/ui/toast";
import { WorkspaceProvider } from "~/features/workspace/WorkspaceProvider";
import { WorkspaceShortcuts } from "~/features/workspace/WorkspaceShortcuts";
import { WorkspaceMutationError } from "~/features/workspace/WorkspaceMutationError";
import { CommandPalette } from "~/features/workspace/CommandPalette";
import { useGitHubEvents } from "~/features/github/useGitHubEvents";
import { FixerNotifications } from "~/features/fixes/FixerNotifications";
import { UpdateNotifications } from "~/features/updates/UpdateNotifications";
import { updatesBridge } from "~/lib/desktop";

export function AppShell() {
  useGitHubEvents();
  return (
    <ToastProvider>
      <WorkspaceProvider>
        <WorkspaceShortcuts />
        <CommandPalette />
        <GuideNotifications />
        <FixerNotifications />
        {updatesBridge !== undefined && <UpdateNotifications />}
        <div className="flex h-dvh min-h-0 w-full flex-col">
          <WorkspaceTabs />
          <main
            data-workspace-panel=""
            className="mx-(--panel-inset) mb-(--panel-inset) flex min-h-0 min-w-0 flex-1 flex-col overflow-clip rounded-(--panel-radius) bg-(--panel) shadow-(--panel-shadow)"
          >
            <WorkspaceMutationError />
            <Outlet />
          </main>
        </div>
      </WorkspaceProvider>
    </ToastProvider>
  );
}
