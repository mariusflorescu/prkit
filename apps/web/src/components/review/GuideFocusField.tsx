import { PlusIcon } from "lucide-react";
import { useState } from "react";
import type { UseFormReturn } from "react-hook-form";

import { Skeleton } from "~/components/ui/skeleton";

import { ComposerControl } from "./agent/ComposerControl";
import type { ComposerValues } from "./composerValues";

/**
 * The PR's own guidance, behind a quiet "Add a focus" until it is wanted. It starts open
 * when the PR already has saved guidance, so it waits for the PR's guide settings rather than
 * offer "Add a focus" and swap it for a filled box. Cmd+Enter generates.
 */
export function GuideFocusField({
  form,
  stacked,
  hasSaved,
  loading,
  onSubmit,
}: {
  form: UseFormReturn<ComposerValues>;
  /** The guidance goes to every chosen layer of the stack. */
  stacked: boolean;
  hasSaved: boolean;
  /** The PR's guide settings, and with them its saved guidance, are still on their way. */
  loading: boolean;
  onSubmit: () => void;
}) {
  const [opened, setOpened] = useState(false);
  if (loading)
    return (
      <div
        role="status"
        aria-busy="true"
        aria-label="Loading the focus"
        className="flex h-6 items-center px-1.5"
      >
        <Skeleton className="h-3 w-20" />
      </div>
    );
  if (!opened && !hasSaved)
    return (
      <ComposerControl size="xs" onClick={() => setOpened(true)}>
        <PlusIcon aria-hidden="true" className="size-3" />
        Add a focus
      </ComposerControl>
    );
  return (
    <textarea
      {...form.register("guidance")}
      aria-label={
        stacked ? "Guidance for every chosen pull request" : "Guidance for this pull request"
      }
      placeholder={
        stacked
          ? "What should these guides focus on? It applies to every chosen layer."
          : "What should this guide focus on?"
      }
      rows={2}
      // Only when the user asked for the field; saved guidance opens it without taking focus.
      autoFocus={opened}
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          onSubmit();
        }
      }}
      className="block max-h-48 min-h-14 w-full resize-none rounded-md border border-input bg-background px-2.5 py-1.5 text-sm outline-none field-sizing-content placeholder:text-muted-foreground/70 focus-visible:ring-2 focus-visible:ring-ring"
    />
  );
}
