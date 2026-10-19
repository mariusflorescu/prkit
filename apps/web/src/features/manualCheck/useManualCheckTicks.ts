import {
  indexTicks,
  type ManualCheckDecision,
  type ManualCheckStep,
  manualCheckStepState,
  manualCheckStepVersion,
  type ManualCheckTicks,
  type ReviewSubject,
  type StepFile,
} from "@prkit/contracts";
import { notifyManager, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import type { ManualCheckBinding } from "~/components/guide/types";
import { toastManager } from "~/components/ui/toast";
import { setManualCheckTicks } from "~/rpc/client";
import { manualCheckTicksQuery } from "~/rpc/queries";

const newest = ({ ticks }: ManualCheckTicks) =>
  ticks.reduce((latest, tick) => Math.max(latest, tick.order), 0);

export function useManualCheckTicks(subject: ReviewSubject): ManualCheckBinding {
  const client = useQueryClient();
  const query = useQuery(manualCheckTicksQuery(subject));
  const save = useMutation({
    mutationFn: (decision: ManualCheckDecision) => setManualCheckTicks(subject, decision),
    // A reply that took long can be older than ticks a later read already brought.
    onSuccess: (ticks) =>
      client.setQueryData(manualCheckTicksQuery(subject).queryKey, (current) =>
        current !== undefined && newest(current) > newest(ticks) ? current : ticks,
      ),
    onError: (error) =>
      toastManager.add({
        type: "error",
        title: "Couldn't save your tick",
        description: error.message,
      }),
  });
  const index = useMemo(
    () => (query.data === undefined ? null : indexTicks(query.data)),
    [query.data],
  );
  const stateOf = useCallback(
    (step: ManualCheckStep, files: ReadonlyArray<StepFile>) =>
      index === null
        ? "unticked"
        : manualCheckStepState(manualCheckStepVersion(step), files, index),
    [index],
  );
  const { mutateAsync } = save;
  const set = useCallback(
    (step: ManualCheckStep, files: ReadonlyArray<StepFile>, tick: boolean) =>
      // The query hands new data to components in a later notify batch. Waiting for it means
      // the box is drawn from the saved ticks by the time the caller hears it worked.
      mutateAsync({
        steps: [{ step: manualCheckStepVersion(step), files }],
        ticked: tick,
      }).then(
        () => new Promise<boolean>((resolve) => notifyManager.schedule(() => resolve(true))),
        () => false,
      ),
    [mutateAsync],
  );
  const { refetch } = query;
  const retry = useCallback(() => void refetch(), [refetch]);
  // A failed refetch keeps the ticks already read: only a first read that fails is an error.
  const loaded = query.data !== undefined;
  const { error } = query;
  return useMemo(() => {
    if (loaded) return { status: "ready", stateOf, set };
    if (error !== null) return { status: "error", message: error.message, retry };
    return { status: "pending" };
  }, [loaded, error, retry, stateOf, set]);
}
