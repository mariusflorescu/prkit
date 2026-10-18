import {
  type ManualCheckDecision,
  type ManualCheckStep,
  manualCheckStepVersion,
  type ManualCheckTicks,
  tickedSteps,
  type ReviewSubject,
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
  const ticked = useMemo(
    () => (query.data === undefined ? null : tickedSteps(query.data)),
    [query.data],
  );
  const isTicked = useCallback(
    (step: ManualCheckStep) => ticked?.has(manualCheckStepVersion(step)) ?? false,
    [ticked],
  );
  const { mutateAsync } = save;
  const set = useCallback(
    (steps: ReadonlyArray<ManualCheckStep>, tick: boolean) => {
      const [first, ...rest] = steps.map(manualCheckStepVersion);
      if (first === undefined) return Promise.resolve(false);
      // The query hands new data to components in a later notify batch. Waiting for it means
      // the box is drawn from the saved ticks by the time the caller hears it worked.
      return mutateAsync({ steps: [first, ...rest], ticked: tick }).then(
        () => new Promise<boolean>((resolve) => notifyManager.schedule(() => resolve(true))),
        () => false,
      );
    },
    [mutateAsync],
  );
  const { refetch } = query;
  const retry = useCallback(() => void refetch(), [refetch]);
  // A failed refetch keeps the ticks already read: only a first read that fails is an error.
  const loaded = query.data !== undefined;
  const { error } = query;
  return useMemo(() => {
    if (loaded) return { status: "ready", isTicked, set };
    if (error !== null) return { status: "error", message: error.message, retry };
    return { status: "pending" };
  }, [loaded, error, retry, isTicked, set]);
}
