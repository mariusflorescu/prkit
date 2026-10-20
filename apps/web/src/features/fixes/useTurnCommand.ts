import type { FixerTurn, PullRequestKey } from "@prkit/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { toastManager } from "~/components/ui/toast";
import { runTurnCommand } from "~/rpc/client";

import { storeFixer } from "./fixerCache";
import { short } from "./fixPresentation";

type Command = Parameters<typeof runTurnCommand>[0];

/** What the owner sees after a push: it landed, or the branch moved and prkit pushed nothing. */
const pushOutcome = (turn: FixerTurn | undefined) => {
  if (turn?.status._tag === "pushed" && turn.commit !== null)
    return { type: "success", title: `Pushed ${short(turn.commit.sha)}` } as const;
  if (turn?.status._tag === "discarded" && turn.status.reason === "moved")
    return { type: "info", title: "The branch moved", description: turn.status.message } as const;
  return null;
};

/** Runs Push, Discard, Retry or Revert on one turn and writes the answer into the cache. */
export function useTurnCommand(key: PullRequestKey, turnId: FixerTurn["id"]) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (command: Command) => runTurnCommand(command, key, turnId),
    onSuccess: (snapshot, command) => {
      storeFixer(client, snapshot);
      if (command !== "push") return;
      const outcome = pushOutcome(snapshot.turns.find((turn) => turn.id === turnId));
      if (outcome !== null) toastManager.add(outcome);
    },
  });
}
