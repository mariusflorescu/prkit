import { useRef } from "react";

import { ReviewAlert } from "~/components/review/ReviewAlert";
import { cn } from "~/lib/utils";

import { AskComposer } from "./AskComposer";
import { AskHistory } from "./AskHistory";
import { askWords, isActive, PLACEHOLDERS, stateWords } from "./askPresentation";
import { useDock } from "./askStore";
import type { AskTarget } from "./askTarget";
import { useAskActions } from "./useAskActions";
import { useAsks } from "./useAsks";
import { useDockCover } from "./useDockCover";
import { useKeepAskedLines } from "./useKeepAskedLines";

/**
 * Ask, held at the bottom of the Guide tab while the guide scrolls under it. Closed it is
 * one row of fixed height, so the guide never moves when an answer arrives; open, it is as
 * tall as its questions, up to about half the window, and grows upward as an answer comes in
 * so the field stays where it is.
 */
export function AskDock({ target }: { target: AskTarget }) {
  const open = useDock(target.key, "open");
  const section = useRef<HTMLElement>(null);
  useKeepAskedLines(section, target);
  useDockCover(section);
  const { state, retry } = useAsks(target.reviewId);
  const actions = useAskActions(target.reviewId);
  const questions = state._tag === "ready" ? state.questions : [];
  const newest = questions.at(-1);
  return (
    <section
      ref={section}
      aria-label={PLACEHOLDERS[askWords(target.key).whole._tag]}
      data-ask-dock={open ? "open" : "closed"}
      className={cn(
        "sticky bottom-0 z-10 flex shrink-0 flex-col border-t border-border bg-background",
        open && "max-h-[max(45dvh,15rem)]",
      )}
    >
      {open && state._tag === "ready" && state.problem !== null && (
        <ReviewAlert
          title="Couldn't keep your questions up to date"
          message={state.problem}
          retry={retry}
        />
      )}
      {open && <AskHistory target={target} state={state} retry={retry} actions={actions} />}
      <AskComposer target={target} open={open} busy={questions.some(isActive)} ask={actions.ask} />
      <p className="sr-only" aria-live="polite">
        {newest === undefined ? "" : stateWords(newest, { step: false })}
      </p>
    </section>
  );
}
