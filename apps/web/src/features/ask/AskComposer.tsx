import { type AskInput, type Question, QUESTION_MAX_LENGTH } from "@prkit/contracts";
import type { UseMutationResult } from "@tanstack/react-query";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import { useForm } from "react-hook-form";

import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

import { askWords, BUSY, PLACEHOLDERS, scopeLabel } from "./askPresentation";
import { useAskStore, useDock } from "./askStore";
import type { AskTarget } from "./askTarget";
import { ScopeChip } from "./ScopeChip";
import { useRevisionGuide } from "./useRevisionGuide";

/**
 * The dock's one row: what the question is about, the question, Ask, and the toggle for the
 * history. The words live in the review's dock, so leaving the tab or the revision keeps them.
 * One question per review is answered at a time, so the field waits while one is.
 */
export function AskComposer({
  target,
  open,
  busy,
  ask,
}: {
  target: AskTarget;
  open: boolean;
  busy: boolean;
  ask: UseMutationResult<Question, Error, AskInput>;
}) {
  const { key } = target;
  const update = useAskStore((state) => state.update);
  const picked = useDock(key, "choice");
  const focus = useDock(key, "focus");
  const draft = useDock(key, "draft");
  const choice = picked?.revision === target.revision ? picked : null;
  const words = askWords(key);
  const scope = choice?.scope ?? words.whole;
  const { guide } = useRevisionGuide(key, target.revision);
  const form = useForm<{ text: string }>({ defaultValues: { text: draft } });
  const field = form.register("text", {
    validate: (text) => {
      const trimmed = text.trim();
      if (trimmed.length === 0) return "Write a question first.";
      return (
        trimmed.length <= QUESTION_MAX_LENGTH ||
        `Keep it under ${QUESTION_MAX_LENGTH.toLocaleString("en-US")} characters.`
      );
    },
  });
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    return form.subscribe({
      formState: { values: true },
      callback: ({ values }) => update(key, { draft: values.text }),
    });
  }, [form, update, key]);
  useEffect(() => {
    if (!focus) return;
    textarea.current?.focus({ preventScroll: true });
    update(key, { focus: false });
  }, [focus, update, key]);
  const submit = form.handleSubmit(({ text }) => {
    update(key, { open: true });
    ask.mutate(
      { reviewId: target.reviewId, revision: target.revision, scope, text: text.trim() },
      {
        onSuccess: () => {
          form.reset({ text: "" });
          update(key, { draft: "" });
        },
      },
    );
  });
  const invalid = form.formState.errors.text?.message;
  const message = invalid ?? ask.error?.message ?? null;
  // The placeholder says why the field waits; words already typed hide it, so this line does.
  const hint = busy ? (draft.trim() === "" ? null : BUSY) : "Cmd+Enter to ask";
  return (
    <form
      noValidate
      aria-label="Ask a question"
      onSubmit={(event) => void submit(event)}
      className="flex flex-col gap-1 px-4 py-2"
    >
      <div className="mx-auto flex w-full max-w-3xl items-end gap-2">
        <div className="flex h-8 shrink-0 items-center">
          <ScopeChip
            label={scopeLabel(scope, guide)}
            {...(choice === null
              ? {}
              : {
                  remove: {
                    label: words.removeScope,
                    onClick: () => update(key, { choice: null }),
                  },
                })}
          />
        </div>
        <textarea
          rows={1}
          aria-label="Your question"
          aria-invalid={Boolean(invalid)}
          placeholder={busy ? BUSY : PLACEHOLDERS[scope._tag]}
          disabled={busy}
          className={cn(
            "block min-w-0 flex-1 rounded-md border border-input bg-background px-2.5 py-1.5 text-sm text-foreground outline-none placeholder:text-placeholder focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-64 aria-invalid:border-error",
            open
              ? "field-sizing-content max-h-32 min-h-8 resize-none"
              : "h-8 resize-none overflow-hidden",
          )}
          onFocus={() => {
            if (!open) update(key, { open: true });
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              update(key, { open: false });
              event.currentTarget.blur();
            } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              if (!event.repeat) void submit();
            }
          }}
          {...field}
          ref={(node) => {
            field.ref(node);
            textarea.current = node;
          }}
        />
        <Button type="submit" size="sm" disabled={busy || ask.isPending}>
          Ask
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost-muted"
          aria-label={open ? "Hide questions" : "Show questions"}
          aria-expanded={open}
          onClick={() => update(key, { open: !open })}
        >
          {open ? <ChevronDownIcon aria-hidden="true" /> : <ChevronUpIcon aria-hidden="true" />}
        </Button>
      </div>
      {open && (
        <p
          role={message === null ? undefined : "alert"}
          className={cn(
            "mx-auto min-h-4 w-full max-w-3xl text-2xs",
            message === null ? "text-muted-foreground" : "text-error-foreground",
          )}
        >
          {message ?? hint}
        </p>
      )}
    </form>
  );
}
