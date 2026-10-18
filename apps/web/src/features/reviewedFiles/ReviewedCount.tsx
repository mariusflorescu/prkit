import { type ReviewableFile, reviewProgress } from "@prkit/contracts";
import { CheckIcon } from "lucide-react";

import { Button } from "~/components/ui/button";

import type { ReviewedFiles } from "./useReviewedFiles";

/** How many of these files the user marked reviewed, in the tab row. */
export function ReviewedCount({
  reviewed,
  files,
}: {
  reviewed: ReviewedFiles;
  files: ReadonlyArray<ReviewableFile>;
}) {
  if (reviewed.status === "pending") return null;
  if (reviewed.status === "error")
    return (
      <span
        role="status"
        data-reviewed-count="error"
        title={reviewed.message}
        className="flex items-center gap-1.5 text-xs text-muted-foreground"
      >
        Reviewed files unavailable
        <Button variant="ghost-muted" size="micro" onClick={reviewed.retry}>
          Retry
        </Button>
      </span>
    );
  const { reviewed: done, changed, total } = reviewProgress(files.map(reviewed.stateOf));
  if (total === 0) return null;
  const complete = done === total;
  // Both wordings size one grid cell from pseudo-elements, so the count keeps the longer width.
  return (
    <span
      role="status"
      data-reviewed-count={complete ? "complete" : "partial"}
      data-partial-size={`${total} / ${total} reviewed`}
      data-complete-size={`All ${total} reviewed`}
      title={changed > 0 ? `${changed} changed since you reviewed` : undefined}
      className="mr-1.5 inline-grid text-xs whitespace-nowrap text-muted-foreground tabular-nums before:invisible before:col-start-1 before:row-start-1 before:content-[attr(data-partial-size)] after:invisible after:col-start-1 after:row-start-1 after:pl-4.5 after:content-[attr(data-complete-size)]"
    >
      <span className="col-start-1 row-start-1 flex items-center justify-end gap-1">
        {complete ? (
          <>
            <CheckIcon aria-hidden="true" className="size-3.5 text-success-foreground" />
            All {total} reviewed
          </>
        ) : (
          `${done} / ${total} reviewed`
        )}
      </span>
    </span>
  );
}
