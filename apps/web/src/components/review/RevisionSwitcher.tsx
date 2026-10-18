import type { RevisionSummary } from "@prkit/contracts";

import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";

import type { ReviewWords } from "./reviewPresentation";

/** A revision number, or the draft an update is writing right now. */
export type GuideChoice = number | "draft";

/** Picks which accepted revision the guide shows, newest first, with the live draft on top. */
export function RevisionSwitcher({
  revisions,
  selected,
  onSelect,
  draft,
  words,
}: {
  revisions: ReadonlyArray<RevisionSummary>;
  selected: GuideChoice;
  onSelect: (choice: GuideChoice) => void;
  /** The update being written, while it has shared a draft. */
  draft: { readonly revision: number } | null;
  words: ReviewWords;
}) {
  const items: ReadonlyArray<{ value: GuideChoice; label: string }> = [
    ...(draft === null
      ? []
      : [{ value: "draft" as const, label: `r${draft.revision} · draft, being written` }]),
    ...revisions
      .toReversed()
      .map((revision) => ({ value: revision.revision, label: words.revision(revision) })),
  ];
  return (
    <Select<GuideChoice>
      value={selected}
      items={items}
      onValueChange={(value) => {
        if (value !== null) onSelect(value);
      }}
    >
      <SelectTrigger aria-label="Guide revision" variant="ghost" size="compact">
        <SelectValue />
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
