import { loginOf, type NormalizedGuide, type PullRequestDetail } from "@prkit/contracts";
import { useState } from "react";
import { useForm, useWatch } from "react-hook-form";

import { SegmentedToggle } from "~/components/SegmentedToggle";
import { Button } from "~/components/ui/button";
import { DescriptionChanges } from "./DescriptionChanges";
import { type DescriptionMode, draftDescription } from "./descriptionDraft";
import type { useUpdateDescription } from "./useUpdateDescription";

const MODES = [
  { id: "section", label: "Add a section" },
  { id: "replace", label: "Replace it" },
] as const;
const VIEWS = [
  { id: "changes", label: "Changes" },
  { id: "edit", label: "Edit" },
] as const;
const MODE_HINTS: Record<DescriptionMode, string> = {
  section: "Keeps your text and adds the guide's summary, steps and reading order after it.",
  replace: "Puts the guide's summary, steps and reading order in place of your text.",
};
const WRITE_HINT = "Starts it with the guide's summary, steps and reading order.";

/**
 * A description drafted from the guide, shown as the change it makes and editable as
 * Markdown. Nothing reaches GitHub until Save.
 */
export function DescriptionEditor({
  detail,
  guide,
  update,
  onClose,
}: {
  detail: PullRequestDetail;
  guide: NormalizedGuide;
  update: ReturnType<typeof useUpdateDescription>;
  onClose: () => void;
}) {
  // The draft and the save both answer the description as it was when the editor opened.
  const [before] = useState(detail.body);
  const hasDescription = before.trim() !== "";
  const form = useForm<{ mode: DescriptionMode; view: "changes" | "edit"; body: string }>({
    defaultValues: {
      mode: "section",
      view: "changes",
      body: draftDescription(before, guide, "section"),
    },
  });
  const mode = useWatch({ control: form.control, name: "mode" });
  const view = useWatch({ control: form.control, name: "view" });
  const body = useWatch({ control: form.control, name: "body" });
  const edited = body !== draftDescription(before, guide, mode);
  const pending = update.isPending;
  const failed = update.isError && update.variables?.undo === false ? update.error : null;
  const submit = form.handleSubmit((values) =>
    update.mutate({ before, after: values.body, undo: false }, { onSuccess: onClose }),
  );
  return (
    <form
      aria-label="Update the description"
      data-description-editor=""
      onSubmit={submit}
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          event.preventDefault();
          void submit();
        }
      }}
      className="flex flex-col gap-3 rounded-lg border border-border p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">
          {hasDescription ? "Update the description" : "Write the description"}
        </h3>
        {hasDescription && (
          <SegmentedToggle
            label="How to use the guide"
            options={MODES}
            value={mode}
            disabled={edited ? "Your edits would be lost. Cancel to start again." : undefined}
            onChange={(next) => {
              form.setValue("mode", next);
              form.setValue("body", draftDescription(before, guide, next));
            }}
          />
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {hasDescription ? MODE_HINTS[mode] : WRITE_HINT}
      </p>
      <SegmentedToggle
        label="Show"
        options={VIEWS}
        value={view}
        onChange={(next) => form.setValue("view", next)}
      />
      {view === "changes" ? (
        <DescriptionChanges before={before} after={body} />
      ) : (
        <textarea
          {...form.register("body")}
          aria-label="Description"
          data-pr-action-input=""
          className="min-h-60 resize-y font-mono"
          disabled={pending}
        />
      )}
      {detail.body !== before && (
        <p role="status" className="text-xs text-muted-foreground">
          The description changed on GitHub after you opened this. Cancel and open it again to start
          from the new one.
        </p>
      )}
      {failed !== null && (
        <p role="alert" className="text-xs text-error-foreground">
          {failed.message}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <span className="mr-auto text-xs text-muted-foreground">
          Saves to GitHub as {loginOf(detail.accountId)}. The title stays as it is.
        </span>
        <Button variant="outline" size="sm" disabled={pending} onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={pending || body === before}>
          {pending ? "Saving..." : failed !== null ? "Retry" : "Save to GitHub"}
        </Button>
      </div>
    </form>
  );
}
