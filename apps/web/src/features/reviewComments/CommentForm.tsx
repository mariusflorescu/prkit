import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";

import { Button } from "~/components/ui/button";
import { type FormKey, useReviewCommentsStore } from "./reviewCommentsStore";

/**
 * One markdown field for a comment, an edit or a reply. Cmd+Enter sends, Escape
 * cancels. The words stay when sending fails, with the error under the field until they change
 * or go again. Both live in the store under `form`, because a diff remounts what it shows under
 * a line whenever its lines or comments change.
 */
export function CommentForm({
  form,
  label,
  submitLabel,
  pendingLabel,
  pending,
  onSubmit,
  onCancel,
  aside,
}: {
  form: FormKey;
  label: string;
  submitLabel: string;
  pendingLabel: string;
  pending: boolean;
  onSubmit: (body: string) => void;
  onCancel: () => void;
  /** Another way out, beside Cancel, told what has been typed so far. */
  aside?: { label: string; onClick: (body: string) => void };
}) {
  const keepWords = useReviewCommentsStore((state) => state.keepWords);
  const focusForm = useReviewCommentsStore((state) => state.focusForm);
  const blurForm = useReviewCommentsStore((state) => state.blurForm);
  const failed = useReviewCommentsStore((state) => state.words.get(form)?.failed ?? null);
  const [kept] = useState(() => useReviewCommentsStore.getState().words.get(form)?.text ?? "");
  const {
    register,
    handleSubmit,
    getValues,
    formState: { errors },
  } = useForm({ defaultValues: { body: kept } });
  const send = handleSubmit(({ body }) => onSubmit(body.trim()));
  const keep = (node: HTMLTextAreaElement) =>
    keepWords(form, { text: node.value, start: node.selectionStart, end: node.selectionEnd });
  const field = register("body", {
    validate: (value) => value.trim().length > 0 || "Write something first.",
    onChange: (event: { target: HTMLTextAreaElement }) => keep(event.target),
  });
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  // In a diff the field mounts before Pierre adds the slot that shows it, when it has no
  // box to focus, so the form that had focus takes it once the field has one.
  useEffect(() => {
    const node = textarea.current;
    if (node === null) return;
    const shown = new ResizeObserver(() => {
      if (node.getClientRects().length === 0) return;
      shown.disconnect();
      const { focus, words } = useReviewCommentsStore.getState();
      const lost = document.activeElement === null || document.activeElement === document.body;
      if (focus?.form !== form || (focus.take === "lost" && !lost)) return;
      const caret = words.get(form);
      node.focus({ preventScroll: focus.take === "lost" });
      node.setSelectionRange(caret?.start ?? node.value.length, caret?.end ?? node.value.length);
    });
    shown.observe(node);
    return () => shown.disconnect();
  }, [form]);
  const message = errors.body?.message ?? failed;
  return (
    <form
      data-comment-form=""
      noValidate
      onSubmit={(event) => void send(event)}
      className="space-y-2 font-sans"
    >
      <textarea
        rows={3}
        aria-label={label}
        aria-invalid={Boolean(errors.body)}
        placeholder="Leave a comment. Markdown works."
        disabled={pending}
        className="field-sizing-content block max-h-64 min-h-16 w-full resize-y rounded-md border border-input bg-background px-2.5 py-1.5 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring aria-invalid:border-error"
        onSelect={(event) => keep(event.currentTarget)}
        onFocus={() => focusForm(form)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            if (!event.repeat) void send();
          }
        }}
        {...field}
        onBlur={(event) => {
          void field.onBlur(event);
          // A field the diff took away keeps its claim, so its remount takes focus back.
          const node = event.currentTarget;
          requestAnimationFrame(() => {
            if (node.isConnected) blurForm(form);
          });
        }}
        ref={(node) => {
          field.ref(node);
          textarea.current = node;
        }}
      />
      {message && (
        <p role="alert" className="text-xs text-error-foreground">
          {message}
        </p>
      )}
      <div className="flex items-center justify-end gap-2">
        <span className="mr-auto text-3xs text-muted-foreground">Cmd+Enter to send</span>
        {aside !== undefined && (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={() => aside.onClick(getValues("body"))}
            disabled={pending}
          >
            {aside.label}
          </Button>
        )}
        <Button type="button" size="xs" variant="ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" size="xs" disabled={pending}>
          {pending ? pendingLabel : submitLabel}
        </Button>
      </div>
    </form>
  );
}
