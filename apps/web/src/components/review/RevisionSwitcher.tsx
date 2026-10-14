import type { RevisionSummary } from "@prkit/contracts";

import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";

import { shortSha, TRIGGER_LABELS } from "./reviewPresentation";

/** A revision number, or the draft an update is writing right now. */
export type GuideChoice = number | "draft";

const labelOf = (revision: RevisionSummary) =>
  `r${revision.revision} · ${shortSha(revision.headSha)} · ${TRIGGER_LABELS[revision.trigger]}`;

/** Picks which accepted revision the Guide tab shows, newest first, with the live draft on top. */
export function RevisionSwitcher({
  revisions,
  selected,
  onSelect,
  draft,
}: {
  revisions: ReadonlyArray<RevisionSummary>;
  selected: GuideChoice;
  onSelect: (choice: GuideChoice) => void;
  /** The update being written, while it has shared a draft. */
  draft: { readonly revision: number } | null;
}) {
  const items: ReadonlyArray<{ value: GuideChoice; label: string }> = [
    ...(draft === null
      ? []
      : [{ value: "draft" as const, label: `r${draft.revision} · draft, being written` }]),
    ...revisions
      .toReversed()
      .map((revision) => ({ value: revision.revision, label: labelOf(revision) })),
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
