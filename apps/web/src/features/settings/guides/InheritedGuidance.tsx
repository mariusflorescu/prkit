import { type EffectiveGuidance, SCOPE_LABELS } from "@prkit/contracts";

import { cn } from "~/lib/utils";

/** The guidance blocks of less specific scopes, read-only, marked when this scope replaces them. */
export function InheritedGuidance({
  blocks,
  replaced,
}: {
  blocks: ReadonlyArray<EffectiveGuidance>;
  /** This scope replaces the guidance above it. */
  replaced: boolean;
}) {
  if (blocks.length === 0) return null;
  return (
    <ul aria-label="Inherited guidance" className="space-y-1.5">
      {blocks.map((block) => {
        const dropped = replaced || block.replacedBy !== null;
        return (
          <li
            key={block.scope}
            aria-label={`${SCOPE_LABELS[block.scope]} guidance${dropped ? ", replaced" : ""}`}
            className="rounded-md border border-border/60 px-2.5 py-1.5 text-xs"
          >
            <p className="text-[11px] text-muted-foreground">
              {SCOPE_LABELS[block.scope]}
              {dropped ? " · replaced, not used" : ""}
            </p>
            <p
              className={cn("whitespace-pre-wrap", dropped && "text-muted-foreground line-through")}
            >
              {block.text}
            </p>
          </li>
        );
      })}
    </ul>
  );
}
