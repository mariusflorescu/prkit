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
  fromGuide = false,
}: Pick<DiffAnnotation, "text" | "tone"> & {
  prUrl?: string | undefined;
  children?: ReactNode;
  pinned?: boolean;
  /** Says where the note comes from, on a diff that isn't the guide's. */
  fromGuide?: boolean;
}) {
  const { icon: Icon, label } = tones[tone];
  return (
    <div
      data-guide-note=""
      data-tone={tone}
      data-pinned={pinned || undefined}
      role="note"
      aria-label={fromGuide ? `Guide ${tone}` : label}
    >
      <span data-guide-note-icon="" title={label}>
        <Icon size={14} aria-hidden="true" />
      </span>
      <div data-guide-note-text="">
        {fromGuide && (
          <span aria-hidden="true" className="block text-[11px] text-muted-foreground">
            Guide
          </span>
        )}
        <InlineMarkdown text={text} prUrl={prUrl} />
        {children}
      </div>
    </div>
  );
}
