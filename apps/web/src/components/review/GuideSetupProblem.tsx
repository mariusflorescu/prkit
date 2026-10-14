import { Button } from "~/components/ui/button";

/** A read the setup needs that failed, in the server's words, with Retry at the block's scale. */
export function GuideSetupProblem({
  title,
  message,
  onRetry,
}: {
  title: string;
  message: string;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      aria-label={title}
      className="flex min-w-0 items-center gap-2 text-xs text-error-foreground"
    >
      <p className="min-w-0">
        <span className="font-medium">{title}.</span> {message}
      </p>
      <Button variant="outline" size="xs" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
