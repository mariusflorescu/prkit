import { isKeepPattern, type PathDecision, SCOPE_LABELS } from "@prkit/contracts";
import { useState } from "react";

import { Button } from "~/components/ui/button";

const verdict = (side: PathDecision) => {
  if (side.winner === null)
    return side.matches.length === 0
      ? "kept (no rule matched)"
      : "kept (the rules that match are off)";
  return (
    <>
      {side.skipped ? "skipped by" : "kept by"} <code>{side.winner.pattern}</code> (
      {SCOPE_LABELS[side.winner.scope]})
    </>
  );
};

/**
 * What decided one path, and on demand every rule that matched it in order: the one
 * that decides, the ones it overrides, and the ones a scope switched off.
 */
export function PathDecisionLine({ side, prefix }: { side: PathDecision; prefix: string | null }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="text-[11px] text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <span data-decision="">
          {prefix === null ? "" : `${prefix}: `}
          {verdict(side)}
        </span>
        {side.matches.length > 0 && (
          <Button
            size="micro"
            variant="ghost-muted"
            aria-expanded={open}
            aria-label={`Why ${side.path}`}
            onClick={() => setOpen(!open)}
          >
            Why
          </Button>
        )}
      </span>
      {open && (
        <ol aria-label={`Rules matching ${side.path}`} className="mt-1 space-y-0.5 pl-3">
          {side.matches.map((rule) => (
            <li key={rule.id}>
              <code>{rule.pattern}</code> ({SCOPE_LABELS[rule.scope]}) ·{" "}
              {!rule.active
                ? `off${rule.decidedBy === null ? "" : ` at ${SCOPE_LABELS[rule.decidedBy]}`}`
                : rule.id === side.winner?.id
                  ? `decides: ${isKeepPattern(rule.pattern) ? "keeps" : "skips"}`
                  : "overridden by a later rule"}
              {rule.active && rule.decidedBy !== null
                ? ` (switched on at ${SCOPE_LABELS[rule.decidedBy]})`
                : ""}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
