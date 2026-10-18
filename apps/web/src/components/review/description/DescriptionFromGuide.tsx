import {
  type NormalizedGuide,
  type PullRequestDetail,
  pullRequestActionReason,
} from "@prkit/contracts";
import { FilePenLineIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { DescriptionEditor } from "./DescriptionEditor";
import { useUpdateDescription } from "./useUpdateDescription";

/** The author's way to bring the PR description in line with the accepted guide. */
export function DescriptionFromGuide({
  detail,
  guide,
}: {
  detail: PullRequestDetail;
  guide: NormalizedGuide;
}) {
  const update = useUpdateDescription(detail);
  const [open, setOpen] = useState(false);
  if (open)
    return (
      <DescriptionEditor
        detail={detail}
        guide={guide}
        update={update}
        onClose={() => {
          update.reset();
          setOpen(false);
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
        onClick={() => setOpen(true)}
      >
        <FilePenLineIcon />
        {detail.body.trim() === ""
          ? "Write the description from the guide"
          : "Update the description from the guide"}
      </Button>
    </div>
  );
}
