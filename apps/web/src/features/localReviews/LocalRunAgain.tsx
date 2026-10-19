import type { LocalReview } from "@prkit/contracts";
import { ChevronDownIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { ButtonLabel } from "~/components/ui/button-label";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";

import { LocalRunAgainForm } from "./LocalRunAgainForm";
import type { useLocalReviewActions } from "./useLocalReviewActions";

/**
 * Run again in one click with the review's own agent: a new snapshot of the folder, and a
 * new revision if anything changed. Beside it, the agent picker to run with another first.
 */
export function LocalRunAgain({
  review,
  generate,
}: {
  review: LocalReview;
  generate: ReturnType<typeof useLocalReviewActions>["generate"];
}) {
  const [open, setOpen] = useState(false);
  return (
    <span className="flex items-center">
      <Button
        variant="outline"
        size="xs"
        disabled={generate.isPending}
        onClick={() => generate.mutate({})}
      >
        <ButtonLabel
          shown={generate.isPending ? "starting" : "run"}
          labels={{ run: "Run again", starting: "Starting…" }}
        />
      </Button>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              variant="ghost-muted"
              size="icon-xs"
              aria-label="Run again with another agent"
            />
          }
        >
          <ChevronDownIcon />
        </PopoverTrigger>
        <PopoverPopup align="end" width="xl" padding="none">
          <LocalRunAgainForm review={review} generate={generate} onStarted={() => setOpen(false)} />
        </PopoverPopup>
      </Popover>
    </span>
  );
}
