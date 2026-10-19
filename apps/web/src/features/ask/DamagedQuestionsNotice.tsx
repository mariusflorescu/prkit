import type { QuestionId } from "@prkit/contracts";
import { TriangleAlertIcon } from "lucide-react";

import { Button } from "~/components/ui/button";

import type { AskActions } from "./useAskActions";

/**
 * Where questions prkit couldn't read would be: that they are there, never what they said,
 * and Remove, which deletes them for good.
 */
export function DamagedQuestionsNotice({
  ids,
  removeDamaged,
}: {
  ids: ReadonlyArray<QuestionId>;
  removeDamaged: AskActions["removeDamaged"];
}) {
  return (
    <div
      role="status"
      aria-label="Questions prkit couldn't read"
      className="flex items-center justify-between gap-3 rounded-md border border-warning/30 bg-warning-surface px-2.5 py-1.5 text-xs text-warning-foreground"
    >
      <span className="flex items-center gap-1.5">
        <TriangleAlertIcon aria-hidden="true" className="size-3.5 shrink-0" />
        {ids.length === 1 ? "One question" : `${ids.length} questions`} couldn't be read. A newer
        prkit may have saved {ids.length === 1 ? "it" : "them"}, or the record was damaged.
      </span>
      <Button
        size="micro"
        variant="outline"
        disabled={removeDamaged.isPending}
        onClick={() => removeDamaged.mutate(ids)}
      >
        Remove
      </Button>
    </div>
  );
}
