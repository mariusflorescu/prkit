import { Button } from "~/components/ui/button";
import { ButtonLabel } from "~/components/ui/button-label";
import { Kbd } from "~/components/ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

import { isMac } from "./reviewFormat";

/** The setup's one primary action, at the PR header's size. Cmd+G is in its tooltip. */
export function GenerateGuideButton({
  label,
  pending,
  disabled,
  shortcut,
  describedBy,
}: {
  label: string;
  pending: boolean;
  disabled: boolean;
  /** Cmd+G starts the same thing: false when the button writes several stack guides. */
  shortcut: boolean;
  describedBy: string | undefined;
}) {
  const button = (
    <Button
      type="submit"
      size="xs"
      disabled={disabled}
      aria-describedby={describedBy}
      aria-keyshortcuts={shortcut ? (isMac() ? "Meta+G" : "Control+G") : undefined}
    >
      <ButtonLabel
        shown={pending ? "starting" : "idle"}
        labels={{ idle: label, starting: "Starting…" }}
      />
    </Button>
  );
  if (!shortcut) return button;
  return (
    <Tooltip>
      {/* A disabled button gets no pointer events, so the tooltip hangs on a wrapper. */}
      <TooltipTrigger render={<span className="inline-flex shrink-0" />}>{button}</TooltipTrigger>
      <TooltipPopup>
        <span className="flex items-center gap-2">
          {pending ? "Starting…" : label}
          <Kbd>{isMac() ? "⌘G" : "Ctrl G"}</Kbd>
        </span>
      </TooltipPopup>
    </Tooltip>
  );
}
