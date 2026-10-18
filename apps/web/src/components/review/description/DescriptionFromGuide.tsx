import {
  type NormalizedGuide,
  type PullRequestDetail,
  pullRequestActionReason,
} from "@prkit/contracts";
import { FilePenLineIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { DescriptionEditor } from "./DescriptionEditor";
import { useUpdateDescription } from "./useUpdateDescription";

/** The author's way to bring the PR description in line with the accepted guide. */
export function DescriptionFromGuide({
  detail,
  guide,
  open,
  onOpenChange,
}: {
  detail: PullRequestDetail;
  guide: NormalizedGuide;
  /** Held by the caller, which keeps the guide's revision while the editor is open. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const update = useUpdateDescription(detail);
  if (open)
    return (
      <DescriptionEditor
        detail={detail}
        guide={guide}
        update={update}
        onClose={() => {
          update.reset();
          onOpenChange(false);
        }}
      />
    );
  const reason = pullRequestActionReason(detail, "edit");
  return (
    <div>
      <Button
        variant="outline"
        size="sm"
        disabled={reason !== null || update.isPending}
        title={reason ?? undefined}
        onClick={() => onOpenChange(true)}
      >
        <FilePenLineIcon />
        {detail.body.trim() === ""
          ? "Write the description from the guide"
          : "Update the description from the guide"}
      </Button>
    </div>
  );
}
