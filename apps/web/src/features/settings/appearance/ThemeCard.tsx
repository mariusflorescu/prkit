import type { ThemePreference } from "@prkit/contracts";

import { cn } from "~/lib/utils";

import type { PreviewTone } from "./themeOptions";
import { ThemeWireframe } from "./ThemeWireframe";

/** One choice in the theme radio group: a miniature of the app in that theme, and its name. */
export function ThemeCard({
  value,
  label,
  tones,
  selected,
  saving,
  onSelect,
}: {
  value: ThemePreference;
  label: string;
  tones: ReadonlyArray<PreviewTone>;
  selected: boolean;
  /**
   * While a pick saves, every card is dimmed and takes no other pick. They stay focusable, so the
   * arrow keys keep their place.
   */
  saving: boolean;
  onSelect: (value: ThemePreference) => void;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer flex-col gap-1.5 rounded-xl border p-2 transition-colors has-focus-visible:outline-2 has-focus-visible:outline-ring has-[[aria-disabled=true]]:cursor-not-allowed has-[[aria-disabled=true]]:opacity-60",
        selected
          ? "border-transparent bg-accent/30 shadow-[inset_0_0_0_1px_var(--ring)]"
          : "border-border/70 bg-card/60 hover:bg-accent/10",
      )}
    >
      <input
        type="radio"
        name="theme"
        value={value}
        checked={selected}
        aria-disabled={saving}
        onChange={() => {
          if (!saving) onSelect(value);
        }}
        className="sr-only"
      />
      <ThemeWireframe tones={tones} className="h-35" />
      <span
        className={cn(
          "text-center text-xs font-medium",
          selected ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {label}
      </span>
    </label>
  );
}
