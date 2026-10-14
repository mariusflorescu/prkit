import { closestCenter, DndContext, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { restrictToFirstScrollableAncestor, restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import { arrayMove, horizontalListSortingStrategy, SortableContext } from "@dnd-kit/sortable";
import { pullRequestKey } from "@prkit/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import { ChevronLeftIcon, ChevronRightIcon, InboxIcon, PlusIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { BrandMark } from "~/components/BrandMark";
import { Button } from "~/components/ui/button";
import { Separator } from "~/components/ui/separator";
import { Skeleton } from "~/components/ui/skeleton";
import { desktopBridge, updatesBridge } from "~/lib/desktop";
import { UpdateButton } from "~/features/updates/UpdateButton";
import { cn } from "~/lib/utils";
import { inboxQuery } from "~/rpc/queries";
import { isSettingsPath } from "~/features/settings/settingsSections";
import { useWorkspaceSession } from "~/features/workspace/sessionStore";
import { useWorkspace } from "~/features/workspace/workspaceContext";
import { PullRequestWorkspaceTab } from "./PullRequestWorkspaceTab";
import { SettingsWorkspaceTab } from "./SettingsWorkspaceTab";
import { ShortcutTooltip } from "./ShortcutTooltip";
import { tabSurface } from "./tabSurface";
import { TitleBarBackdrop } from "./TitleBarBackdrop";

export function WorkspaceTabs() {
  const workspace = useWorkspace();
  const inbox = useQuery(inboxQuery);
  const path = useRouterState({ select: (state) => state.location.pathname });
  const rows = workspace.data?.open ?? [];
  const keys = rows.map((row) => row.key);
  const onSettings = isSettingsPath(path);
  const settingsOpen = useWorkspaceSession((state) => state.settingsTab.open) || onSettings;
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const viewport = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  useEffect(() => {
    const node = viewport.current;
    if (!node) return;
    const update = () =>
      setEdges({
        left: node.scrollLeft > 1,
        right: node.scrollLeft + node.clientWidth < node.scrollWidth - 1,
      });
    let width = node.clientWidth;
    const observer = new ResizeObserver(() => {
      update();
      // The scroll buttons show once the tabs overflow, narrowing the strip: keep the active tab in view.
      if (node.clientWidth < width)
        node
          .querySelector<HTMLElement>("[data-active-tab=true]")
          ?.scrollIntoView({ block: "nearest", inline: "nearest" });
      width = node.clientWidth;
    });
    observer.observe(node);
    if (node.firstElementChild) observer.observe(node.firstElementChild);
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey) return;
      let delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) delta *= 16;
      if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) delta *= node.clientWidth;
      const before = node.scrollLeft;
      node.scrollLeft += delta;
      if (before !== node.scrollLeft) event.preventDefault();
    };
    node.addEventListener("scroll", update, { passive: true });
    node.addEventListener("wheel", wheel, { passive: false });
    update();
    return () => {
      observer.disconnect();
      node.removeEventListener("scroll", update);
      node.removeEventListener("wheel", wheel);
    };
  }, []);
  const activeTab = onSettings ? "settings" : path === "/" ? "inbox" : workspace.data?.activeKey;
  useEffect(() => {
    if (!workspace.data || activeTab === undefined) return;
    viewport.current
      ?.querySelector<HTMLElement>("[data-active-tab=true]")
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [workspace.data, activeTab]);
  return (
    <header
      data-workspace-tabbar=""
      className={cn(
        "relative isolate flex h-(--workspace-topbar-height) shrink-0 items-center gap-1 pr-3 pl-[max(0.75rem,var(--workspace-traffic-light-inset))]",
        desktopBridge && "drag-region",
      )}
    >
      <TitleBarBackdrop />
      <span aria-hidden className="flex shrink-0 items-center pr-4 pl-1 text-foreground">
        <BrandMark wordmark className="h-4" />
      </span>
      <div
        ref={viewport}
        data-workspace-tab-viewport=""
        className="min-w-0 overflow-x-auto p-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [-webkit-app-region:no-drag]"
      >
        <nav aria-label="Workspace tabs" className="flex w-max items-center gap-1">
          <ShortcutTooltip label="Inbox" shortcut="inbox">
            <Link
              to="/"
              aria-current={path === "/" ? "page" : undefined}
              data-active-tab={path === "/"}
              className={cn(
                "flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring",
                tabSurface(path === "/"),
              )}
            >
              <InboxIcon aria-hidden="true" className="size-3" /> Inbox
            </Link>
          </ShortcutTooltip>
          {(rows.length > 0 || settingsOpen) && (
            <Separator orientation="vertical" className="mx-1 h-4" />
          )}
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToHorizontalAxis, restrictToFirstScrollableAncestor]}
            onDragEnd={({ active, over }) => {
              if (!over || active.id === over.id) return;
              const from = keys.findIndex((key) => key === active.id);
              const to = keys.findIndex((key) => key === over.id);
              if (from >= 0 && to >= 0)
                workspace.send({ kind: "reorder", keys: arrayMove(keys, from, to) });
            }}
          >
            <SortableContext items={keys} strategy={horizontalListSortingStrategy}>
              {rows.map((row) => (
                <PullRequestWorkspaceTab
                  key={row.key}
                  row={row}
                  entry={inbox.data?.entries.find(
                    (entry) =>
                      pullRequestKey(entry.ref) === row.key && entry.accountId === row.accountId,
                  )}
                  active={path.startsWith("/pr/") && workspace.data?.activeKey === row.key}
                />
              ))}
            </SortableContext>
          </DndContext>
          {workspace.pending && (
            <span aria-busy="true" aria-label="Loading open pull requests" className="flex gap-1">
              <Skeleton className="h-6 w-12" />
              <Skeleton className="h-6 w-12" />
            </span>
          )}
          {settingsOpen && <SettingsWorkspaceTab active={onSettings} />}
        </nav>
      </div>
      {(edges.left || edges.right) && (
        <div className="flex shrink-0">
          <Button
            size="icon-micro"
            variant="ghost-muted"
            aria-label="Scroll tabs left"
            disabled={!edges.left}
            onClick={() => viewport.current?.scrollBy({ left: -180 })}
          >
            <ChevronLeftIcon />
          </Button>
          <Button
            size="icon-micro"
            variant="ghost-muted"
            aria-label="Scroll tabs right"
            disabled={!edges.right}
            onClick={() => viewport.current?.scrollBy({ left: 180 })}
          >
            <ChevronRightIcon />
          </Button>
        </div>
      )}
      <ShortcutTooltip label="Open a pull request" shortcut="openPullRequest">
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label="Open a pull request"
          onClick={() => useWorkspaceSession.getState().setPaletteOpen(true, "open-pr")}
        >
          <PlusIcon />
        </Button>
      </ShortcutTooltip>
      {workspace.error && (
        <div role="alert" className="flex items-center gap-2 text-xs text-error-foreground">
          <p>{workspace.error.message}</p>
          <Button size="sm" variant="outline" onClick={workspace.retry}>
            Retry
          </Button>
        </div>
      )}
      {!workspace.pending && !workspace.error && rows.length === 0 && (
        <span role="status" className="sr-only">
          No open pull requests
        </span>
      )}
      <div className="min-w-6 flex-1 self-stretch" />
      {updatesBridge !== undefined && <UpdateButton />}
    </header>
  );
}
