import type { PullRequestKey } from "@prkit/contracts";
import { useEffect } from "react";

import { useReviewCommentsStore } from "./reviewCommentsStore";

/** Counts an inline edit or reply as open while `open`, so the diff around it holds still. */
export function useOpenForm(key: PullRequestKey, open: boolean) {
  const openForm = useReviewCommentsStore((state) => state.openForm);
  const closeForm = useReviewCommentsStore((state) => state.closeForm);
  useEffect(() => {
    if (!open) return;
    openForm(key);
    return () => closeForm(key);
  }, [key, open, openForm, closeForm]);
}
