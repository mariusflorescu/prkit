import type { GuidanceMode } from "@prkit/contracts";

import { Button } from "~/components/ui/button";

const MODES: ReadonlyArray<{ readonly value: GuidanceMode; readonly label: string }> = [
  { value: "append", label: "Add to the guidance above" },
  { value: "replace", label: "Replace the guidance above" },
];

/** Whether a scope's guidance adds to the less specific scopes' or drops them. */
export function GuidanceModeControl({
  label,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  value: GuidanceMode;
  onChange: (value: GuidanceMode) => void;
  disabled?: boolean;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="flex w-fit items-center gap-0.5 rounded-md border border-border p-0.5"
    >
      {MODES.map((mode) => (
        <Button
          key={mode.value}
          role="radio"
          aria-checked={value === mode.value}
          size="micro"
          variant={value === mode.value ? "secondary" : "ghost-muted"}
          disabled={disabled}
          onClick={() => onChange(mode.value)}
        >
          {mode.label}
        </Button>
      ))}
    </div>
  );
}
