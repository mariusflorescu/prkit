import type { PullRequestDetail } from "@prkit/contracts";
import { useLayoutEffect, useRef, type ReactNode } from "react";

import { CollapsingPinned } from "~/components/CollapsingPinned";
import { useCollapsingHeader } from "~/hooks/useCollapsingHeader";
import {
  readViewMemory,
  useWorkspaceSession,
  type PullRequestTab,
} from "~/features/workspace/sessionStore";
import { StackStrip } from "~/features/stack/StackStrip";
import { PullRequestCompactHeader } from "./PullRequestCompactHeader";
import { PullRequestHeader } from "./PullRequestHeader";
import { PullRequestActionsProvider } from "./PullRequestActionsProvider";
import "./pullRequest.css";

export function PullRequestViewport({
  detail,
  tab,
  tabs,
  children,
  reviewAction,
}: {
  detail: PullRequestDetail;
  tab: PullRequestTab;
  tabs: ReactNode;
  children: ReactNode;
  reviewAction?: ReactNode;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const { collapsed, sentinel } = useCollapsingHeader(scroll);
  useLayoutEffect(() => {
    const viewport = scroll.current;
    if (!viewport) return;
    viewport.scrollTop = readViewMemory(detail.key)?.scroll[tab] ?? 0;
    const remember = () =>
      useWorkspaceSession.getState().rememberScroll(detail.key, tab, viewport.scrollTop);
    window.addEventListener("pagehide", remember);
    return () => {
      remember();
      window.removeEventListener("pagehide", remember);
    };
  }, [detail.key, tab]);
  return (
    <PullRequestActionsProvider key={detail.key} detail={detail}>
      <div ref={scroll} data-pr-scroll="" className="min-h-0 flex-1 overflow-y-auto">
        <PullRequestHeader
          detail={detail}
          sentinel={sentinel}
          reviewAction={reviewAction}
          collapsed={collapsed}
        />
        <StackStrip detail={detail} />
        <CollapsingPinned
          collapsed={collapsed}
          compact={
            <PullRequestCompactHeader
              detail={detail}
              collapsed={collapsed}
              reviewAction={reviewAction}
            />
          }
        >
          {tabs}
        </CollapsingPinned>
        <div data-pr-content="">{children}</div>
      </div>
    </PullRequestActionsProvider>
  );
}
