import type { StackMembership } from "@prkit/contracts";
import { LayersIcon } from "lucide-react";

/** "Stack 2/3": the PR's layer in its GitHub stack, counted from the bottom. */
export function InboxStackMark({ stack }: { stack: StackMembership | null }) {
  if (stack === null) return null;
  return (
    <span
      data-stack-mark=""
      title={`Layer ${stack.position} of ${stack.size} in a stack on ${stack.base}`}
      className="flex shrink-0 items-center gap-1 text-2xs text-muted-foreground"
    >
      <LayersIcon aria-hidden="true" className="size-3" />
      Stack {stack.position}/{stack.size}
    </span>
  );
}
