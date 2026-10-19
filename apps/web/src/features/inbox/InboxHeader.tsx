import { RefreshCwIcon } from "lucide-react";
import type { Ref } from "react";

import { Button } from "~/components/ui/button";
import { ButtonLabel } from "~/components/ui/button-label";
import { WorkspacePageHeader } from "~/components/WorkspacePageHeader";

import { InboxUpdated } from "./InboxUpdated";

/** The Inbox's title row: how old it is and Refresh. It scrolls away with the list. */
export function InboxHeader({
  sentinel,
  collapsed,
  fetchedAt,
  refreshing,
  onRefresh,
}: {
  sentinel: Ref<HTMLSpanElement>;
  collapsed: boolean;
  fetchedAt: string | null;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  return (
    <div className="relative">
      <WorkspacePageHeader title="Inbox">
        <div className="ml-auto flex items-center gap-3" inert={collapsed} aria-hidden={collapsed}>
          <InboxUpdated fetchedAt={fetchedAt} />
          <Button size="sm" variant="ghost-muted" disabled={refreshing} onClick={onRefresh}>
            <ButtonLabel
              icon={<RefreshCwIcon className="size-3.5" />}
              shown={refreshing ? "refreshing" : "refresh"}
              labels={{ refresh: "Refresh", refreshing: "Refreshing..." }}
            />
          </Button>
        </div>
      </WorkspacePageHeader>
      <span ref={sentinel} aria-hidden className="absolute bottom-0 left-0 h-px w-px" />
    </div>
  );
}
