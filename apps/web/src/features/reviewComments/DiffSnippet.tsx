import { keyedItems } from "~/components/guide/keyedItems";
import { cn } from "~/lib/utils";

/** Diff rows as text, each line coloured by its `+`, `-` or space marker. */
export function DiffSnippet({ text, label }: { text: string; label: string }) {
  return (
    <pre
      aria-label={label}
      className="overflow-x-auto rounded-md border border-border/60 bg-muted/30 py-1 font-mono text-2xs leading-5"
    >
      {keyedItems(text.split("\n"), (line) => line).map(({ key, value: line }) => (
        <span
          key={key}
          className={cn(
            "block whitespace-pre px-2",
            line.startsWith("+") && "bg-diff-addition/15 text-diff-addition-foreground",
            line.startsWith("-") && "bg-diff-deletion/15 text-diff-deletion-foreground",
          )}
        >
          {line || " "}
        </span>
      ))}
    </pre>
  );
}
