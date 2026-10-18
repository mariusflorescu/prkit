import type { CommentContext } from "@prkit/contracts";

import { keyedItems } from "~/components/guide/keyedItems";
import { cn } from "~/lib/utils";

/**
 * Diff rows as text, each line coloured by its `+`, `-` or space marker. The rows around
 * them, when given, are muted so the commented rows stand out.
 */
export function DiffSnippet({
  text,
  label,
  context = null,
}: {
  text: string;
  label: string;
  context?: CommentContext | null;
}) {
  const rows = [
    ...(context?.before ?? []).map((line) => ({ line, around: true })),
    ...text.split("\n").map((line) => ({ line, around: false })),
    ...(context?.after ?? []).map((line) => ({ line, around: true })),
  ];
  return (
    <pre
      aria-label={label}
      className="overflow-x-auto rounded-md border border-border/60 bg-muted/30 py-1 font-mono text-2xs leading-5"
    >
      {keyedItems(rows, (row) => `${row.around}${row.line}`).map(
        ({ key, value: { line, around } }) => (
          <span
            key={key}
            className={cn(
              "block whitespace-pre px-2",
              around && "text-muted-foreground",
              !around &&
                line.startsWith("+") &&
                "bg-diff-addition/15 text-diff-addition-foreground",
              !around &&
                line.startsWith("-") &&
                "bg-diff-deletion/15 text-diff-deletion-foreground",
            )}
          >
            {line || " "}
          </span>
        ),
      )}
    </pre>
  );
}
