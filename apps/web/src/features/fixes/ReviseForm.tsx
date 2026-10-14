import type { FixerTurn, PullRequestKey } from "@prkit/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";

import { Button } from "~/components/ui/button";
import { reviseFix } from "~/rpc/client";

import { storeFixer } from "./fixerCache";

/** "Ask the agent to change": a note to the same session, which edits the result in place. */
export function ReviseForm({
  prKey,
  turn,
  onDone,
}: {
  prKey: PullRequestKey;
  turn: FixerTurn;
  onDone: () => void;
}) {
  const client = useQueryClient();
  const form = useForm<{ note: string }>({ defaultValues: { note: "" } });
  const revise = useMutation({
    mutationFn: (note: string) => reviseFix(prKey, turn.id, note),
    onSuccess: (snapshot) => {
      storeFixer(client, snapshot);
      onDone();
    },
  });
  const submit = form.handleSubmit((values) => revise.mutate(values.note.trim()));
  const error = form.formState.errors.note;
  return (
    <form
      noValidate
      aria-label="Ask the agent to change"
      onSubmit={(event) => void submit(event)}
      className="mt-3 space-y-2"
    >
      <textarea
        autoFocus
        rows={2}
        aria-label="What should the agent change?"
        aria-invalid={Boolean(error)}
        placeholder="What should the agent change?"
        disabled={revise.isPending}
        className="field-sizing-content block max-h-40 min-h-14 w-full resize-y rounded-md border border-input bg-background px-2.5 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring aria-invalid:border-error"
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            if (!event.repeat) void submit();
          }
        }}
        {...form.register("note", {
          validate: (note) => note.trim().length > 0 || "Say what the agent should change.",
        })}
      />
      {error && (
        <p role="alert" className="text-xs text-error-foreground">
          {error.message}
        </p>
      )}
      {revise.error && (
        <p role="alert" className="text-xs text-error-foreground">
          {revise.error.message}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={revise.isPending}>
          {revise.isPending ? "Sending…" : "Send to the agent"}
        </Button>
      </div>
    </form>
  );
}
