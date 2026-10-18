import { answerText, type Question } from "@prkit/contracts";
import { CopyIcon, PinIcon, PinOffIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";

import type { AskActions } from "./useAskActions";

const copy = (question: Question) =>
  navigator.clipboard.writeText(answerText(question.answer)).then(
    () => toastManager.add({ type: "success", title: "Answer copied" }),
    () => toastManager.add({ type: "error", title: "Couldn't copy the answer" }),
  );

/**
 * Stop while it is being answered, Retry once it stopped or failed, and Pin and Copy once
 * answered. `place` is where a pin would show: the overview, its chapter, or nowhere.
 */
export function QuestionActions({
  question,
  place,
  actions,
}: {
  question: Question;
  place: "overview" | "chapter" | null;
  actions: AskActions;
}) {
  const { stop, retry, pin } = actions;
  switch (question.state._tag) {
    case "starting":
    case "waiting":
    case "answering":
      return (
        <Button
          size="xs"
          variant="outline"
          disabled={stop.isPending && stop.variables === question.id}
          onClick={() => stop.mutate(question.id)}
        >
          Stop
        </Button>
      );
    case "stopped":
    case "failed":
      return (
        <Button
          size="xs"
          variant="outline"
          disabled={retry.isPending && retry.variables === question.id}
          onClick={() => retry.mutate(question.id)}
        >
          Retry
        </Button>
      );
    case "answered": {
      const pinned = question.pinnedAt !== null;
      return (
        <>
          {(pinned || place !== null) && (
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={pin.isPending && pin.variables?.id === question.id}
              onClick={() => pin.mutate({ id: question.id, pinned: !pinned })}
            >
              {pinned ? <PinOffIcon aria-hidden="true" /> : <PinIcon aria-hidden="true" />}
              {pinned ? "Unpin" : place === "overview" ? "Pin to overview" : "Pin to chapter"}
            </Button>
          )}
          <Button size="xs" variant="ghost-muted" onClick={() => void copy(question)}>
            <CopyIcon aria-hidden="true" />
            Copy
          </Button>
        </>
      );
    }
  }
}
