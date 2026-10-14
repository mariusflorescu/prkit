import type { PullRequestLabel } from "@prkit/contracts";

import { cn } from "~/lib/utils";

/**
 * A label tinted with its own color: a wash of it behind, the name in a mix of it and the
 * theme's foreground. The mix leans to the foreground because GitHub allows any color; at
 * 30% of the label on light and 45% on dark, white, black and pale yellows stay readable.
 * A color that is not six hex digits gets the muted tag.
 */
export function LabelChip({ label }: { label: PullRequestLabel }) {
  const color = /^[0-9a-f]{6}$/i.test(label.color) ? `#${label.color}` : null;
  return (
    <span
      title={label.name}
      style={color === null ? undefined : { "--label": color }}
      className={cn(
        "inline-block max-w-48 truncate rounded px-1.5 py-0.5 align-middle text-3xs leading-none font-medium",
        color === null
          ? "bg-muted text-muted-foreground"
          : "bg-[color-mix(in_srgb,var(--label)_8%,transparent)] text-[color-mix(in_srgb,var(--label)_30%,var(--color-foreground))] dark:bg-[color-mix(in_srgb,var(--label)_12%,transparent)] dark:text-[color-mix(in_srgb,var(--label)_45%,var(--color-foreground))]",
      )}
    >
      {label.name}
    </span>
  );
}
