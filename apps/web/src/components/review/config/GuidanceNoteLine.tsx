/** The agent's one sentence on how it settled conflicting guidance. Advisory, never proof. */
export function GuidanceNoteLine({ note }: { note: string }) {
  return (
    <aside
      aria-label="The agent's note on your guidance"
      className="shrink-0 border-b border-border/60 px-(--workspace-gutter-start) py-1.5 text-xs text-muted-foreground"
    >
      <span className="font-medium">Agent's note on your guidance:</span> {note}
    </aside>
  );
}
