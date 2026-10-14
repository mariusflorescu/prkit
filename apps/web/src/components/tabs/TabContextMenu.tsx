import { ContextMenu } from "@base-ui/react/context-menu";
import type { OpenPullRequest } from "@prkit/contracts";
import type { ReactElement } from "react";
import { useWorkspace } from "~/features/workspace/workspaceContext";

export function TabContextMenu({
  row,
  children,
}: {
  row: OpenPullRequest;
  children: ReactElement;
}) {
  const workspace = useWorkspace();
  const rows = workspace.data?.open ?? [];
  const index = rows.findIndex((item) => item.key === row.key);
  const actions = [
    { label: "Close", targets: [row] },
    { label: "Close others", targets: rows.filter((item) => item.key !== row.key) },
    { label: "Close to the right", targets: rows.slice(index + 1) },
    { label: "Close all PRs", targets: rows },
  ];
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger render={children} />
      <ContextMenu.Portal>
        <ContextMenu.Positioner className="z-50">
          <ContextMenu.Popup className="min-w-40 rounded-md border border-border bg-popover p-1 text-xs text-popover-foreground shadow-md">
            {actions.map((action) => (
              <ContextMenu.Item
                key={action.label}
                disabled={action.targets.length === 0}
                className="cursor-default rounded-sm px-2 py-1.5 outline-none data-highlighted:bg-accent data-disabled:opacity-50"
                onClick={() => workspace.closeMany(action.targets.map((target) => target.key))}
              >
                {action.label}
              </ContextMenu.Item>
            ))}
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
