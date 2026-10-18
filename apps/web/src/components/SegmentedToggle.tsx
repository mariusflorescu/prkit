import { cn } from "~/lib/utils";

/** A few exclusive choices shown side by side, the pressed one raised. */
export function SegmentedToggle<Id extends string>({
  label,
  options,
  value,
  onChange,
  disabled,
}: {
  label: string;
  options: ReadonlyArray<{ readonly id: Id; readonly label: string }>;
  value: Id;
  onChange: (id: Id) => void;
  /** Why the choice can't change now, shown as each option's title. */
  disabled?: string | undefined;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex w-fit items-center gap-0.5 rounded-md bg-muted p-0.5 text-xs"
    >
      {options.map((entry) => (
        <button
          key={entry.id}
          type="button"
          aria-pressed={value === entry.id}
          disabled={disabled !== undefined && value !== entry.id}
          title={disabled}
          onClick={() => onChange(entry.id)}
          className={cn(
            "rounded-md px-2.5 py-1 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-64",
            value === entry.id
              ? "bg-background text-foreground shadow-xs ring-1 ring-border"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {entry.label}
        </button>
      ))}
    </div>
  );
}
