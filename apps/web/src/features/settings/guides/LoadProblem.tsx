import { Button } from "~/components/ui/button";

/** A read that failed, in the server's words, with a way to try again. */
export function LoadProblem({
  title,
  message,
  retry,
}: {
  title: string;
  message: string;
  retry: () => void;
}) {
  return (
    <div
      role="alert"
      aria-label={title}
      className="flex items-center justify-between gap-3 rounded-md border border-error/30 bg-error-surface px-3 py-2 text-xs text-error-foreground"
    >
      <p>
        <span className="font-medium">{title}.</span> {message}
      </p>
      <Button size="compact" variant="outline" onClick={retry}>
        Retry
      </Button>
    </div>
  );
}
