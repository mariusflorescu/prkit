import type { DiffLineRef } from "@prkit/contracts";

import { InlineButton } from "~/components/ui/button";
import { LineLink } from "./LineLink";
import type { GuideChapter } from "./types";

/** Where a pre-flight point's evidence is: its chapter, and its line when it has one. */
export function PreflightLinks({
  chapter,
  at,
  onChapter,
  onLine,
}: {
  chapter: GuideChapter | undefined;
  at: DiffLineRef | null;
  onChapter: (id: string) => void;
  onLine: (at: DiffLineRef) => void;
}) {
  if (chapter === undefined && at === null) return null;
  return (
    <div data-preflight-links="">
      {chapter !== undefined && (
        <InlineButton onClick={() => onChapter(chapter.id)}>Open {chapter.title}</InlineButton>
      )}
      {at !== null && (
        <LineLink at={at} label={`${at.path.split("/").at(-1)}:${at.line}`} onOpen={onLine} />
      )}
    </div>
  );
}
