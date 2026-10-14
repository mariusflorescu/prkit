import type { NormalizedGuide } from "@prkit/contracts";

import { GuideNote } from "~/components/diff/GuideNote";
import { InlineButton } from "~/components/ui/button";
import { keyedItems } from "./keyedItems";

export function FocusList({
  guide,
  onChapter,
  prUrl,
}: {
  guide: NormalizedGuide;
  onChapter: (id: string) => void;
  prUrl?: string | undefined;
}) {
  if (guide.focus.length === 0) return null;
  return (
    <section data-guide-focus="">
      <h2>Worth a closer look</h2>
      {keyedItems(guide.focus, (item) => JSON.stringify(item)).map(({ key, value: item }) => {
        const chapter = guide.chapters.find((candidate) => candidate.id === item.chapter);
        return (
          <GuideNote key={key} text={item.text} tone={item.tone} prUrl={prUrl}>
            {chapter && (
              <div className="mt-1">
                <InlineButton onClick={() => onChapter(chapter.id)}>
                  Open {chapter.title}
                </InlineButton>
              </div>
            )}
          </GuideNote>
        );
      })}
    </section>
  );
}
