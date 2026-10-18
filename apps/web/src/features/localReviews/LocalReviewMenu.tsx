import type { LocalReview } from "@prkit/contracts";
import { MoreHorizontalIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";

import { RemoveLocalReviewDialog } from "./RemoveLocalReviewDialog";

/** The header's ⋯: Remove, behind a confirmation, since it deletes every revision. */
export function LocalReviewMenu({ review }: { review: LocalReview }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <Menu>
        <MenuTrigger
          render={<Button size="icon-xs" variant="ghost-muted" />}
          aria-label="More local review actions"
        >
          <MoreHorizontalIcon />
        </MenuTrigger>
        <MenuPopup align="end" sideOffset={6}>
          <MenuItem onClick={() => setConfirming(true)}>Remove local review…</MenuItem>
        </MenuPopup>
      </Menu>
      <RemoveLocalReviewDialog review={review} open={confirming} onOpenChange={setConfirming} />
    </>
  );
}
