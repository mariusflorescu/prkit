import { Popover } from "@base-ui/react/popover";
import type { PullRequestDetail } from "@prkit/contracts";
import { useQuery } from "@tanstack/react-query";
import { MessageSquarePlusIcon } from "lucide-react";
import { useState } from "react";

import { SendToAgentForm } from "~/features/fixes/SendToAgentForm";
import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { pendingCommentsQuery } from "~/rpc/queries";
import { FinishReviewForm } from "./FinishReviewForm";

const MODES = [
  { id: "github", label: "Post to GitHub" },
  { id: "agent", label: "Send to agent" },
] as const;

/**
 * Opens "Finish your review"; its count is the drafts waiting to be posted. The
 * same drafts can go to the PR's fix agent instead.
 */
export function ReviewButton({ detail }: { detail: PullRequestDetail }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<(typeof MODES)[number]["id"]>("github");
  const pending = useQuery(pendingCommentsQuery(detail.key, detail.accountId));
  const drafts = pending.data?.comments.filter((comment) => comment.state === "draft").length ?? 0;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        aria-label={drafts > 0 ? `Review, ${drafts} pending` : "Review"}
        render={<Button size="xs" variant={drafts > 0 ? "default" : "outline"} />}
      >
        <MessageSquarePlusIcon />
        Review
        {drafts > 0 && <span className="tabular-nums">({drafts})</span>}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner align="end" sideOffset={6} className="z-50">
          <Popover.Popup className="w-[28rem] max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-popover p-4 text-popover-foreground shadow-md">
            <div
              role="group"
              aria-label="Where your comments go"
              className="mb-3 flex items-center gap-0.5 rounded-md bg-muted p-0.5 text-xs"
            >
              {MODES.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  aria-pressed={mode === entry.id}
                  onClick={() => setMode(entry.id)}
                  className={cn(
                    "flex-1 rounded-md px-2.5 py-1 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    mode === entry.id
                      ? "bg-background text-foreground shadow-xs ring-1 ring-border"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {entry.label}
                </button>
              ))}
            </div>
            <Popover.Title className="text-sm font-medium">
              {mode === "github" ? "Finish your review" : "Send to agent"}
            </Popover.Title>
            <Popover.Description className="mt-1 text-xs text-muted-foreground">
              {mode === "github"
                ? `Posted to GitHub as ${detail.accountId}.`
                : "The agent fixes them on this branch. You review the change before anything is pushed."}
            </Popover.Description>
            {open &&
              (mode === "github" ? (
                <FinishReviewForm detail={detail} onDone={() => setOpen(false)} />
              ) : (
                <SendToAgentForm detail={detail} onDone={() => setOpen(false)} />
              ))}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
