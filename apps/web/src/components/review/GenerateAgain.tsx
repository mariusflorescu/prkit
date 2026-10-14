import type { PullRequestDetail, Review } from "@prkit/contracts";
import { ChevronDownIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";

import { GuideSetup } from "./GuideSetup";

/**
 * "Generate again" with the review's own agent in one click, and next to it the
 * guide setup to change the agent, model or focus first.
 */
export function GenerateAgain({
  detail,
  review,
  pending,
  onGenerate,
}: {
  detail: PullRequestDetail;
  review: Review;
  pending: boolean;
  onGenerate: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <span className="flex items-center">
      <Button variant="ghost-muted" size="compact" disabled={pending} onClick={onGenerate}>
        Generate again
      </Button>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              variant="ghost-muted"
              size="icon-xs"
              aria-label="Generate again with other settings"
            />
          }
        >
          <ChevronDownIcon />
        </PopoverTrigger>
        <PopoverPopup align="end" width="xl" padding="none">
          <GuideSetup
            detail={detail}
            review={review}
            submitLabel="Generate again"
            frame="bare"
            onStarted={() => setOpen(false)}
          />
        </PopoverPopup>
      </Popover>
    </span>
  );
}
