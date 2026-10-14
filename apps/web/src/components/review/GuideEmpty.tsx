import type { PullRequestDetail, Review } from "@prkit/contracts";
import { BookOpenTextIcon } from "lucide-react";

import { EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "~/components/ui/empty";

import { useGuideConfigPreview } from "./config/useGuideConfigPreview";
import { GuideSetup } from "./GuideSetup";

/** What the agent will read, from the same skipped count that blocks Generate. */
const describe = (total: number, skipped: number, everythingSkipped: boolean) => {
  const files = total === 1 ? "the 1 changed file" : `all ${total} changed files`;
  if (everythingSkipped)
    return `Your ignore rules skip ${files}, so your agent has nothing to read.`;
  const read = total - skipped;
  const reads = skipped === 0 ? files : `${read} of the ${total} changed files`;
  return `Your agent reads ${reads} and walks you through ${read === 1 ? "it" : "them"}: the core change first, one idea per chapter.`;
};

/**
 * A PR with no guide yet, or a stopped review that never wrote one: what a guide is, then
 * its setup. Held at the top, so opening the focus field moves nothing above it.
 */
export function GuideEmpty({
  detail,
  review,
  stopped,
}: {
  detail: PullRequestDetail;
  review: Review | null;
  stopped: boolean;
}) {
  const preview = useGuideConfigPreview(detail);
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col items-center gap-5 px-6 pt-6 pb-4">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <BookOpenTextIcon />
        </EmptyMedia>
        <EmptyTitle role="heading" aria-level={2}>
          {stopped ? "This review is stopped" : "No guide yet"}
        </EmptyTitle>
        <EmptyDescription>
          {stopped
            ? "It stopped before a guide was written. Generate again to have your agent write one."
            : describe(
                detail.changedFiles,
                preview.skipped?.length ?? 0,
                preview.everythingSkipped,
              )}
        </EmptyDescription>
      </EmptyHeader>
      <div className="w-full">
        <GuideSetup
          detail={detail}
          review={review}
          submitLabel={stopped ? "Generate again" : "Generate guide"}
          frame="card"
        />
      </div>
    </div>
  );
}
