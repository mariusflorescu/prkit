import { type GuideScopeName, SCOPE_LABELS } from "@prkit/contracts";

import { cn } from "~/lib/utils";

import { type OverrideChoice, OverrideControl } from "./OverrideControl";

const stateText = (
  choice: OverrideChoice,
  parent: { readonly active: boolean; readonly decidedBy: GuideScopeName | null },
) => {
  if (choice === "on") return "On here";
  if (choice === "off") return "Off here";
  const state = parent.active ? "On" : "Off";
  return parent.decidedBy === null ? state : `${state} from ${SCOPE_LABELS[parent.decidedBy]}`;
};

/** One inherited rule or focus area, where it comes from, and this scope's say on it. */
export function InheritedItemRow({
  title,
  code = false,
  detail,
  scope,
  parent,
  choice,
  onChoice,
  disabled,
}: {
  title: string;
  /** A pattern, shown as code. */
  code?: boolean;
  detail?: string;
  scope: GuideScopeName;
  parent: { readonly active: boolean; readonly decidedBy: GuideScopeName | null };
  choice: OverrideChoice;
  onChoice: (choice: OverrideChoice) => void;
  disabled: boolean;
}) {
  const active = choice === "inherit" ? parent.active : choice === "on";
  return (
    <li
      aria-label={`${title}, from ${SCOPE_LABELS[scope]}`}
      className="flex items-center justify-between gap-3 rounded-md border border-border/60 px-2.5 py-1.5"
    >
      <div className="min-w-0">
        <p
          className={cn(
            "truncate text-xs",
            code && "font-mono",
            !active && "text-muted-foreground line-through",
          )}
        >
          {title}
        </p>
        <p className="truncate text-[11px] text-muted-foreground">
          {SCOPE_LABELS[scope]} · {stateText(choice, parent)}
          {detail === undefined ? "" : ` · ${detail}`}
        </p>
      </div>
      <OverrideControl
        label={`${title}: inherit, on or off`}
        value={choice}
        onChange={onChoice}
        disabled={disabled}
      />
    </li>
  );
}
