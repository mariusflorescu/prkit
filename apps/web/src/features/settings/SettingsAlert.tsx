import { Button } from "~/components/ui/button";

/** A failed save or refresh in a Settings section: what went wrong, and a way to try again. */
export function SettingsAlert({ message, retry }: { message: string; retry: () => void }) {
  return (
    <div
      role="alert"
      className="mt-4 flex items-center justify-between gap-3 border-y border-error/30 bg-error-surface py-3 text-xs text-error-foreground"
    >
      <p>{message}</p>
      <Button size="sm" variant="outline" onClick={retry}>
        Retry
      </Button>
    </div>
  );
}
