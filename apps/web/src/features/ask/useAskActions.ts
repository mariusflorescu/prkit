import type { QuestionId, ReviewId } from "@prkit/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { toastManager } from "~/components/ui/toast";
import {
  askQuestion,
  pinAnswer,
  removeDamagedQuestions,
  retryQuestion,
  stopQuestion,
} from "~/rpc/client";
import { asksQuery } from "~/rpc/queries";

import { asksAdded } from "./askEvents";

const failed = (title: string) => (error: Error) =>
  toastManager.add({ type: "error", title, description: error.message });

/**
 * Ask, stop, retry, pin and remove the questions prkit couldn't read. What they change arrives
 * on the watch, which only a new question gets ahead of, so its card shows at once.
 */
export function useAskActions(reviewId: ReviewId) {
  const client = useQueryClient();
  const ask = useMutation({
    mutationFn: askQuestion,
    onSuccess: (question) =>
      client.setQueryData(asksQuery(reviewId).queryKey, (state) => asksAdded(state, question)),
  });
  const stop = useMutation({
    mutationFn: stopQuestion,
    onError: failed("Couldn't stop the answer"),
  });
  const retry = useMutation({
    mutationFn: retryQuestion,
    onError: failed("Couldn't ask again"),
  });
  const pin = useMutation({
    mutationFn: (input: { id: QuestionId; pinned: boolean }) => pinAnswer(input.id, input.pinned),
    onError: failed("Couldn't change the pin"),
  });
  const removeDamaged = useMutation({
    mutationFn: (ids: ReadonlyArray<string>) => removeDamagedQuestions(reviewId, ids),
    onError: failed("Couldn't remove it"),
  });
  return { ask, stop, retry, pin, removeDamaged };
}

export type AskActions = ReturnType<typeof useAskActions>;
