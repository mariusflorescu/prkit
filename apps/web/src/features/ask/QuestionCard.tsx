import { askedChapter, type Question } from "@prkit/contracts";
import { useCallback } from "react";

import { AnswerBody } from "./AnswerBody";
import { AnswerHeader } from "./AnswerHeader";
import { AnswerStatus } from "./AnswerStatus";
import { askedOn, scopeLabel } from "./askPresentation";
import type { AskTarget } from "./askTarget";
import { QuestionActions } from "./QuestionActions";
import { ScopeChip } from "./ScopeChip";
import type { AskActions } from "./useAskActions";
import { useRevisionGuide } from "./useRevisionGuide";

const answeredBy = (state: Question["state"]) => {
  switch (state._tag) {
    case "answering":
    case "answered":
      return { agent: state.agent, basis: state.basis };
    case "stopped":
      return state.agent === null || state.basis === null
        ? null
        : { agent: state.agent, basis: state.basis };
    case "starting":
    case "waiting":
    case "failed":
      return null;
  }
};

/** One question in the dock's history: what it asked, and its answer as far as it got. */
export function QuestionCard({
  question,
  target,
  actions,
}: {
  question: Question;
  target: AskTarget;
  actions: AskActions;
}) {
  const { guide, files } = useRevisionGuide(target.key, question.revision);
  const { openLine } = target;
  const onLine = useCallback(
    (path: string, line: number) => openLine(question.revision, path, line),
    [openLine, question.revision],
  );
  const by = answeredBy(question.state);
  const badge = askedOn(question.revision, target.revision);
  const chapter = guide === undefined ? undefined : askedChapter(question.scope, guide);
  return (
    <article
      aria-label={question.text}
      data-question-state={question.state._tag}
      className="rounded-lg border border-border bg-card p-3 text-card-foreground"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <ScopeChip label={scopeLabel(question.scope, guide)} />
        {badge !== null && (
          <span className="rounded-sm bg-muted px-1.5 text-2xs leading-5 text-muted-foreground">
            {badge}
          </span>
        )}
        {question.askedBy !== null && (
          <span className="text-2xs text-muted-foreground">Asked by {question.askedBy}</span>
        )}
      </div>
      <p className="mt-2 text-sm font-medium break-words whitespace-pre-wrap">{question.text}</p>
      <div className="mt-3 space-y-2 rounded-md bg-muted/50 px-3 py-2">
        {by !== null && (
          <AnswerHeader
            agent={by.agent}
            basis={by.basis}
            answered={question.state._tag === "answered"}
          />
        )}
        {question.answer.length > 0 && (
          <AnswerBody parts={question.answer} files={files} onLine={onLine} />
        )}
        <AnswerStatus question={question}>
          <QuestionActions
            question={question}
            place={chapter === undefined ? null : chapter === null ? "overview" : "chapter"}
            actions={actions}
          />
        </AnswerStatus>
      </div>
    </article>
  );
}
