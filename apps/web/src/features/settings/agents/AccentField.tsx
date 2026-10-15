import { XIcon } from "lucide-react";

import { Button } from "~/components/ui/button";

/**
 * The instance's optional marker color, the one color prkit takes from the user. Shown next to
 * its initials wherever it's picked; empty means initials alone.
 */
export function AccentField({
  id,
  value,
  onChange,
  disabled = false,
}: {
  id: string;
  value: string | null;
  onChange: (value: string | null) => void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-xs font-medium">
        Accent
      </label>
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="color"
          value={value ?? "#808080"}
          disabled={disabled}
          aria-describedby={`${id}-hint`}
          onChange={(event) => onChange(event.target.value)}
          className="h-8 w-10 cursor-pointer rounded-md border border-input bg-background p-0.5 disabled:opacity-64"
        />
        <span className="font-mono text-xs text-muted-foreground">{value ?? "None"}</span>
        {value !== null && (
          <Button
            type="button"
            size="icon-micro"
            variant="ghost-muted"
            aria-label="Remove the accent"
            disabled={disabled}
            onClick={() => onChange(null)}
          >
            <XIcon />
          </Button>
        )}
      </div>
      <p id={`${id}-hint`} className="text-2xs text-muted-foreground">
        Optional. Marks this agent wherever you pick one.
      </p>
    </div>
  );
}
