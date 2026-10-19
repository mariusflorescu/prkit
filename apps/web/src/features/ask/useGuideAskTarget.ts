import type { ReviewId, ReviewKey } from "@prkit/contracts";
import { useEffect, useMemo } from "react";

import { useLineFocus } from "~/components/diff/lineFocus";

import type { AskTarget } from "./askTarget";

/**
 * The Ask target of a guide page: its review and the revision on screen. `pick` switches the
 * page to another revision, which an answer's `path:line` link does before it shows the line.
 */
export function useGuideAskTarget({
  key,
  reviewId,
  revision,
  pick,
}: {
  key: ReviewKey;
  reviewId: ReviewId;
  revision: number;
  pick: (revision: number) => void;
}) {
  const reveal = useLineFocus((state) => state.reveal);
  const clear = useLineFocus((state) => state.clear);
  // A line asked for here is for this guide only.
  useEffect(() => () => clear(), [clear]);
  return useMemo<AskTarget>(
    () => ({
      key,
      reviewId,
      revision,
      openLine: (asked, path, line) => {
        if (asked !== revision) pick(asked);
        reveal({ revision: asked, path, line });
      },
    }),
    [key, reviewId, revision, pick, reveal],
  );
}
