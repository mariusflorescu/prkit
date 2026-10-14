import type { AccountId, FixTarget, PullRequestKey } from "@prkit/contracts";
import { useQuery } from "@tanstack/react-query";
import { BotIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { pullRequestDetailQuery } from "~/rpc/queries";

import { SendToAgentForm } from "./SendToAgentForm";

/** A draft's or thread's own "Send to agent", with the same form as the Review popover. */
export function SendToAgentButton({
  pr,
  target,
  label,
}: {
  pr: { key: PullRequestKey; accountId: AccountId };
  target: FixTarget;
  /** What it sends, for its accessible name. */
  label: string;
}) {
  const [open, setOpen] = useState(false);
  // The PR view has it loaded already; a diff without it offers no button.
  const detail = useQuery(pullRequestDetailQuery(pr.key, pr.accountId)).data;
  if (detail === undefined || detail.state !== "open") return null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={<Button size="icon-xs" variant="ghost-muted" />}
        aria-label={`Send ${label} to agent`}
      >
        <BotIcon />
      </PopoverTrigger>
      <PopoverPopup width="xl" align="end">
        <p className="text-sm font-medium">Send to agent</p>
        <p className="mt-1 text-xs text-muted-foreground">
          The agent fixes it on this branch. You review the change before anything is pushed.
        </p>
        {open && <SendToAgentForm detail={detail} only={target} onDone={() => setOpen(false)} />}
      </PopoverPopup>
    </Popover>
  );
}
