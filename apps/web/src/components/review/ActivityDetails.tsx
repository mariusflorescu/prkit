import type { ReviewActivity } from "@prkit/contracts";

const SHOWN = 60;

/** The raw tool calls behind the narration, newest last, folded away by default. */
export function ActivityDetails({ lines }: { lines: ReadonlyArray<ReviewActivity> }) {
  const tools = lines.filter((line) => line.kind === "tool" || line.kind === "error").slice(-SHOWN);
  return (
    <details className="group text-xs">
      <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground">
        Details
      </summary>
      <ol
        role="log"
        aria-label="Agent activity"
        className="mt-2 max-h-56 space-y-1 overflow-y-auto rounded-md border border-border/60 bg-muted/30 px-3 py-2 font-mono"
      >
        {tools.length === 0 ? (
          <li className="text-muted-foreground">No tool calls yet.</li>
        ) : (
          tools.map((line) => (
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
