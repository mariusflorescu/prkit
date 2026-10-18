import type { Question } from "@prkit/contracts";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

import { stateWords } from "./askPresentation";

/**
 * One line under every answer, its height kept in every state so a change never moves the
 * text: what the question is doing, and what can be done about it.
 */
export function AnswerStatus({ question, children }: { question: Question; children: ReactNode }) {
  const words = question.state._tag === "answered" ? null : stateWords(question, { step: true });
  return (
    <div className="flex min-h-7 flex-wrap items-center justify-end gap-x-2 gap-y-1">
      <p
        className={cn(
          "min-w-0 flex-1 text-xs",
          question.state._tag === "failed" ? "text-error-foreground" : "text-muted-foreground",
        )}
      >
        {words}
      </p>
      {children}
    </div>
  );
}
