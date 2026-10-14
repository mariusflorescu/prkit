import type { PullRequestDetail } from "@prkit/contracts";
import { CopyIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

/** A quiet copy button beside the head branch; its tooltip shows the command it copies. */
export function PullRequestCheckoutButton({ detail }: { detail: PullRequestDetail }) {
  const command = `gh pr checkout ${detail.ref.number}`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost-muted"
            size="icon-micro"
            aria-label={`Copy ${command}`}
            onClick={() =>
              void navigator.clipboard.writeText(command).then(
                () => toastManager.add({ type: "success", title: "Checkout command copied" }),
                () =>
                  toastManager.add({
                    type: "error",
                    title: "Couldn't copy the checkout command",
                    description: `Run ${command} in ${detail.ref.owner}/${detail.ref.repo}.`,
                  }),
              )
            }
          />
        }
      >
        <CopyIcon />
      </TooltipTrigger>
      <TooltipPopup variant="code">{command}</TooltipPopup>
    </Tooltip>
  );
}
