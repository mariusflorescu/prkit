import { AskAboutChapterButton } from "./AskAboutChapterButton";
import { AskPins } from "./AskPins";
import type { AskTarget } from "./askTarget";

/** What Ask adds to a guide: the answers pinned to it, and each chapter's way in. */
export const askAside = (target: AskTarget) => ({
  overview: <AskPins target={target} chapterId={null} />,
  chapter: (chapterId: string) => ({
    action: <AskAboutChapterButton target={target} chapterId={chapterId} />,
    notes: <AskPins target={target} chapterId={chapterId} />,
  }),
});
