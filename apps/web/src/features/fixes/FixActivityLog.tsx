import type { FixerActivity } from "@prkit/contracts";

const SHOWN = 60;

/** The agent's tool calls and prkit's notes for one turn, newest last, folded away by default. */
export function FixActivityLog({
  lines,
  open = false,
}: {
  lines: ReadonlyArray<FixerActivity>;
  open?: boolean;
}) {
  const shown = lines.filter((line) => line.kind !== "phase").slice(-SHOWN);
  return (
    <details className="group text-xs" open={open}>
      <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground">
        Activity
      </summary>
      <ol
        role="log"
        aria-label="Agent activity"
        className="mt-2 max-h-56 space-y-1 overflow-y-auto rounded-md border border-border/60 bg-muted/30 px-3 py-2 font-mono"
      >
        {shown.length === 0 ? (
          <li className="text-muted-foreground">Nothing yet.</li>
        ) : (
          shown.map((line) => (
            <li key={line.id} data-kind={line.kind} className="min-w-0">
              <span className={line.kind === "error" ? "text-error-foreground" : undefined}>
                {line.text}
              </span>
              {line.detail !== null && (
                <span className="block truncate text-muted-foreground" title={line.detail}>
                  {line.detail}
                </span>
              )}
            </li>
          ))
        )}
      </ol>
    </details>
  );
}
