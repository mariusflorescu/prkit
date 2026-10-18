import { MessageCircleQuestionIcon } from "lucide-react";

import { Button } from "~/components/ui/button";

import { askAbout } from "./askStore";
import type { AskTarget } from "./askTarget";

/** A chapter's way into Ask: the dock opens on this chapter with the cursor in its field. */
export function AskAboutChapterButton({
  target,
  chapterId,
}: {
  target: AskTarget;
  chapterId: string;
}) {
  return (
    <Button
      size="xs"
      variant="ghost-muted"
      onClick={() =>
        askAbout(target.key, {
          scope: { _tag: "chapter", chapterId },
          revision: target.revision,
        })
      }
    >
      <MessageCircleQuestionIcon aria-hidden="true" />
      Ask about this chapter
    </Button>
  );
}
