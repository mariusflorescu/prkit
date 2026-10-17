import { useEffect, useRef } from "react";
import { useForm } from "react-hook-form";

import { Button } from "~/components/ui/button";

/**
 * One markdown field for a comment, an edit or a reply. Cmd+Enter sends, Escape
 * cancels. The words stay when sending fails, with the error under the field.
 */
export function CommentForm({
  label,
  submitLabel,
  pendingLabel,
  defaultValue = "",
  error,
  pending,
  onSubmit,
  onCancel,
}: {
  label: string;
  submitLabel: string;
  pendingLabel: string;
  defaultValue?: string;
  error: string | null;
  pending: boolean;
  onSubmit: (body: string) => void;
  onCancel: () => void;
}) {
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm({ defaultValues: { body: defaultValue } });
  const send = handleSubmit(({ body }) => onSubmit(body.trim()));
  const field = register("body", {
    validate: (value) => value.trim().length > 0 || "Write something first.",
  });
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  // In a diff the field mounts before Pierre adds the slot that shows it, when it has no
  // box to focus, so it takes focus once it has one.
  useEffect(() => {
    const node = textarea.current;
    if (node === null) return;
    const shown = new ResizeObserver(() => {
      if (node.getClientRects().length === 0) return;
      shown.disconnect();
      node.focus();
      node.setSelectionRange(node.value.length, node.value.length);
    });
    shown.observe(node);
    return () => shown.disconnect();
  }, []);
  const message = errors.body?.message ?? error;
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
