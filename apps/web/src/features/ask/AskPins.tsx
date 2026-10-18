import { askedChapter } from "@prkit/contracts";

import type { AskTarget } from "./askTarget";
import { AskPinnedNote } from "./AskPinnedNote";
import { useAskActions } from "./useAskActions";
import { useAsks } from "./useAsks";
import { useRevisionGuide } from "./useRevisionGuide";

/**
 * The answers pinned to the overview (`chapterId` null) or to one chapter of the revision
 * on screen. A pin shows only on the revision it was asked on.
 */
export function AskPins({ target, chapterId }: { target: AskTarget; chapterId: string | null }) {
  const { state } = useAsks(target.reviewId);
  const { pin } = useAskActions(target.reviewId);
  const { guide, files } = useRevisionGuide(target.key, target.revision);
  if (state._tag !== "ready" || guide === undefined) return null;
  const pinned = state.questions
    .flatMap((question) => {
      if (
        question.pinnedAt === null ||
        question.state._tag !== "answered" ||
        question.revision !== target.revision
      )
        return [];
      const chapter = askedChapter(question.scope, guide);
      return chapter !== undefined && (chapter?.id ?? null) === chapterId
        ? [{ question, agent: question.state.agent, at: question.pinnedAt }]
        : [];
    })
    .toSorted((a, b) => a.at.localeCompare(b.at));
  if (pinned.length === 0) return null;
  return (
    <div
      className={chapterId === null ? "mb-12 flex max-w-3xl flex-col gap-3" : "flex flex-col gap-3"}
    >
      {pinned.map(({ question, agent }) => (
        <AskPinnedNote
          key={question.id}
          question={question}
          agent={agent}
          target={target}
          files={files}
          unpin={() => pin.mutate({ id: question.id, pinned: false })}
          unpinning={pin.isPending && pin.variables?.id === question.id}
        />
      ))}
    </div>
  );
}
