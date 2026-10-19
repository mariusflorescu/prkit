import { useEffect, useLayoutEffect, useRef } from "react";

import { ReviewAlert } from "~/components/review/ReviewAlert";
import { Skeleton } from "~/components/ui/skeleton";
import type { AsksState } from "~/rpc/queries";

import { askWords } from "./askPresentation";
import type { AskTarget } from "./askTarget";
import { DamagedQuestionsNotice } from "./DamagedQuestionsNotice";
import { QuestionCard } from "./QuestionCard";
import type { AskActions } from "./useAskActions";

/**
 * The dock's questions, oldest first, in a scroll region of their own. It follows a growing
 * answer only while the reader is at the bottom, and always shows a question just asked.
 */
export function AskHistory({
  target,
  state,
  retry,
  actions,
}: {
  target: AskTarget;
  state: AsksState;
  retry: () => void;
  actions: AskActions;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const questions = state._tag === "ready" ? state.questions : [];
  const damaged = state._tag === "ready" ? state.damaged : [];
  const newest = questions.at(-1)?.id;
  useEffect(() => {
    const region = scroller.current;
    const inner = content.current;
    if (region === null || inner === null) return;
    const follow = new ResizeObserver(() => {
      if (atBottom.current) region.scrollTop = region.scrollHeight;
    });
    follow.observe(inner);
    return () => follow.disconnect();
  }, []);
  useLayoutEffect(() => {
    const region = scroller.current;
    if (region === null || newest === undefined) return;
    atBottom.current = true;
    region.scrollTop = region.scrollHeight;
  }, [newest]);
  return (
    <div
      ref={scroller}
      role="region"
      aria-label="Your questions"
      onScroll={(event) => {
        const region = event.currentTarget;
        atBottom.current = region.scrollHeight - region.scrollTop - region.clientHeight < 24;
      }}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
    >
      <div ref={content} className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-4 py-3">
        {state._tag === "loading" ? (
          <div
            role="status"
            aria-busy="true"
            aria-label="Loading your questions"
            className="flex flex-col gap-3"
          >
            <Skeleton shape="card" className="h-28" />
            <Skeleton shape="card" className="h-20" />
          </div>
        ) : state._tag === "error" ? (
          <ReviewAlert title="Couldn't load your questions" message={state.message} retry={retry} />
        ) : (
          <>
            {damaged.length > 0 && (
              <DamagedQuestionsNotice ids={damaged} removeDamaged={actions.removeDamaged} />
            )}
            {questions.length === 0 && damaged.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                {askWords(target.key).empty}
              </p>
            ) : (
              questions.map((question) => (
                <QuestionCard
                  key={question.id}
                  question={question}
                  target={target}
                  actions={actions}
                />
              ))
            )}
          </>
        )}
      </div>
    </div>
  );
}
