import { Button } from "~/components/ui/button";

/** The guide settings changed since this revision; another one would be written fresh. */
export function SettingsChangedNotice({
  onRegenerate,
  pending,
}: {
  onRegenerate: () => void;
  pending: boolean;
}) {
  return (
    <span
      role="status"
      aria-label="Settings changed since this revision"
      className="flex items-center gap-1 text-warning-foreground"
    >
      Settings changed since this revision
      <span aria-hidden="true">·</span>
      <Button size="compact" variant="ghost-muted" disabled={pending} onClick={onRegenerate}>
        Regenerate
      </Button>
    </span>
  );
}
