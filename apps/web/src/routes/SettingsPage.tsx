import { Outlet, useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";

import { SettingsNav } from "~/features/settings/SettingsNav";
import { settingsSectionAt } from "~/features/settings/settingsSections";
import { useWorkspaceSession } from "~/features/workspace/sessionStore";

/** The Settings tab: a section list on the left, the chosen section on the right. */
export function SettingsPage() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const active = settingsSectionAt(pathname)?.id;
  useEffect(() => {
    if (active !== undefined) useWorkspaceSession.getState().setSettingsTab({ section: active });
  }, [active]);
  return (
    <div className="flex min-h-0 flex-1">
      <h1 className="sr-only">Settings</h1>
      <SettingsNav active={active} />
      <div className="min-w-0 flex-1 overflow-y-auto">
        <Outlet />
      </div>
    </div>
  );
}
