import type { ReactNode } from "react";

import { InlineMarkdown } from "./InlineMarkdown";
import { tones } from "./tone";
import type { DiffAnnotation } from "./types";

export function GuideNote({
  text,
  tone,
  prUrl,
  children,
  pinned = false,
}: Pick<DiffAnnotation, "text" | "tone"> & {
  prUrl?: string | undefined;
  children?: ReactNode;
  pinned?: boolean;
}) {
  const { icon: Icon, label } = tones[tone];
  return (
    <div
      data-guide-note=""
      data-tone={tone}
      data-pinned={pinned || undefined}
      role="note"
      aria-label={label}
    >
      <span data-guide-note-icon="" title={label}>
        <Icon size={14} aria-hidden="true" />
      </span>
      <div data-guide-note-text="">
        <InlineMarkdown text={text} prUrl={prUrl} />
        {children}
      </div>
    </div>
  );
}
