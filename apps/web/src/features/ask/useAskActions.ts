import type { QuestionId, ReviewId } from "@prkit/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { toastManager } from "~/components/ui/toast";
import { askQuestion, pinAnswer, retryQuestion, stopQuestion } from "~/rpc/client";
import { asksQuery } from "~/rpc/queries";

import { asksAdded } from "./askEvents";

const failed = (title: string) => (error: Error) =>
  toastManager.add({ type: "error", title, description: error.message });

/**
 * Ask, stop, retry and pin. What they change arrives on the watch, which only a new question
 * gets ahead of, so its card shows at once.
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
  return { ask, stop, retry, pin };
}

export type AskActions = ReturnType<typeof useAskActions>;
