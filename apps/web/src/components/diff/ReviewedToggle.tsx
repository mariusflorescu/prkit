import type { ChapterReview, FileReviewState } from "@prkit/contracts";
import { useId, useState } from "react";

import { Checkbox } from "~/components/ui/checkbox";

const UNKNOWN_TITLE = "prkit can't tell which version of this file this is, so it can't mark it.";

/**
 * The Reviewed checkbox of a file or a chapter. It shows only what the server saved:
 * the box stays as it was until `onChange` resolves.
 */
export function ReviewedToggle({
  name,
  state,
  title,
  onChange,
}: {
  /** A file's path or a chapter's title, so each checkbox has its own accessible name. */
  name: string;
  /** `partial` is a chapter with some of its files reviewed. */
  state: FileReviewState | ChapterReview["state"];
  title?: string | undefined;
  onChange: (reviewed: boolean) => Promise<boolean>;
}) {
  const [saving, setSaving] = useState(false);
  const changedId = useId();
  return (
    <span data-reviewed-toggle="" data-state={state} className="flex items-center gap-2">
      {state === "changed" && (
        <span
          id={changedId}
          className="rounded-md bg-warning-surface px-1.5 py-0.5 text-warning-foreground"
        >
          Changed since you reviewed
        </span>
      )}
      <label
        title={state === "unknown" ? UNKNOWN_TITLE : title}
        className="flex cursor-pointer items-center gap-1.5 select-none has-data-disabled:cursor-not-allowed"
      >
        <Checkbox
          size="sm"
          checked={state === "reviewed"}
          indeterminate={state === "partial"}
          disabled={state === "unknown" || saving}
          aria-describedby={state === "changed" ? changedId : undefined}
          onCheckedChange={(reviewed) => {
            setSaving(true);
            void onChange(reviewed).finally(() => setSaving(false));
          }}
        />
        Reviewed
        <span className="sr-only">{` ${name}`}</span>
      </label>
    </span>
  );
}
