import { Popover } from "@base-ui/react/popover";
import type { PullRequestDetail } from "@prkit/contracts";
import { useForm, useWatch } from "react-hook-form";

import { Button } from "~/components/ui/button";
import { usePullRequestActions } from "./actionContext";
import { PullRequestMarkdown } from "./PullRequestMarkdown";

export function PullRequestEditForm({ detail }: { detail: PullRequestDetail }) {
  const actions = usePullRequestActions();
  const form = useForm({
    defaultValues: { title: detail.title, body: detail.body, preview: false },
  });
  const preview = useWatch({ control: form.control, name: "preview" });
  const body = useWatch({ control: form.control, name: "body" });
  const submit = form.handleSubmit((values) =>
    actions.run({ kind: "edit", title: values.title.trim(), body: values.body }),
  );
  return (
    <form
      onSubmit={submit}
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          event.preventDefault();
          void submit();
        }
      }}
      className="space-y-3"
    >
      <Popover.Title className="text-sm font-semibold">Edit pull request</Popover.Title>
      <Popover.Description className="text-xs text-muted-foreground">
        Save the title and Markdown description on GitHub.
      </Popover.Description>
      <label className="block space-y-1 text-xs">
        Title
        <input
          {...form.register("title", {
            maxLength: { value: 256, message: "Keep the title under 257 characters." },
            validate: (value) => value.trim().length > 0 || "Enter a title.",
          })}
          data-pr-action-input=""
          aria-invalid={Boolean(form.formState.errors.title)}
          disabled={actions.pending}
        />
      </label>
      {form.formState.errors.title && (
        <p role="alert" className="text-xs text-error-foreground">
          {form.formState.errors.title.message}
        </p>
      )}
      <label className="block space-y-1 text-xs">
        Description
        <textarea
          {...form.register("body")}
          data-pr-action-input=""
          className="min-h-40 resize-y"
          disabled={actions.pending}
        />
      </label>
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" {...form.register("preview")} />
        Preview Markdown
      </label>
      {preview && (
        <div className="max-h-48 overflow-auto rounded border border-border p-2">
          {body ? (
            <PullRequestMarkdown body={body} />
          ) : (
            <p role="status" className="text-xs text-muted-foreground">
              No description
            </p>
          )}
        </div>
      )}
      {actions.error && (
        <p role="alert" className="text-xs text-error-foreground">
          {actions.error.message}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" disabled={actions.pending} onClick={actions.dismiss}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={actions.pending}>
          {actions.pending ? "Saving..." : actions.error ? "Retry" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}
