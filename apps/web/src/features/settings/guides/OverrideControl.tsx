import { Button } from "~/components/ui/button";

export type OverrideChoice = "inherit" | "on" | "off";

const CHOICES: ReadonlyArray<{ readonly value: OverrideChoice; readonly label: string }> = [
  { value: "inherit", label: "Inherit" },
  { value: "on", label: "On" },
  { value: "off", label: "Off" },
];

/** Inherit, On or Off for one inherited item at this scope. */
export function OverrideControl({
  label,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  value: OverrideChoice;
  onChange: (value: OverrideChoice) => void;
  disabled?: boolean;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="flex shrink-0 items-center gap-0.5 rounded-md border border-border p-0.5"
    >
      {CHOICES.map((choice) => (
        <Button
          key={choice.value}
          role="radio"
          aria-checked={value === choice.value}
          size="micro"
          variant={value === choice.value ? "secondary" : "ghost-muted"}
          disabled={disabled}
          onClick={() => onChange(choice.value)}
        >
          {choice.label}
        </Button>
      ))}
    </div>
  );
}
