import { Button } from "~/components/ui/button";

export function ReviewAlert({
  title,
  message,
  detail,
  retry,
  retrying = false,
}: {
  title: string;
  message: string;
  detail?: string;
  retry: () => void;
  retrying?: boolean;
}) {
  return (
    <div role="alert" className="m-6 rounded-lg border border-error/30 bg-error-surface p-4">
      <h2 className="text-sm font-medium">{title}</h2>
      <p className="mt-1 text-xs text-error-foreground">{message}</p>
      {detail !== undefined && <p className="mt-1 text-xs text-muted-foreground">{detail}</p>}
      <div className="mt-3">
        <Button variant="outline" size="xs" disabled={retrying} onClick={retry}>
          Retry
        </Button>
      </div>
    </div>
  );
}
