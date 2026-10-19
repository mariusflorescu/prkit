import type { FixerTurn, PullRequestDetail } from "@prkit/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { ButtonLabel } from "~/components/ui/button-label";
import { toastManager } from "~/components/ui/toast";
import { getFixerPatch } from "~/rpc/client";
import { pushAccessQuery } from "~/rpc/queries";

import { plural } from "./fixPresentation";
import { ReviseForm } from "./ReviseForm";
import { useTurnCommand } from "./useTurnCommand";

/** Push, Discard, Ask the agent to change and Copy patch for a turn that is ready. */
export function FixTurnActions({ detail, turn }: { detail: PullRequestDetail; turn: FixerTurn }) {
  const command = useTurnCommand(detail.key, turn.id);
  const access = useQuery(pushAccessQuery(detail.key, detail.accountId));
  const [revising, setRevising] = useState(false);
  const copy = useMutation({
    mutationFn: async () => {
      const patch = await getFixerPatch(detail.key, turn.id);
      await navigator.clipboard.writeText(patch);
    },
    onSuccess: () =>
      toastManager.add({
        type: "success",
        title: "Patch copied",
        description: "Apply it with git am in a checkout of the branch.",
      }),
  });
  const rebase = turn.work._tag === "conflicts" && turn.work.strategy === "rebase";
  const held =
    turn.work._tag === "conflicts" ? turn.work.conflicted.filter((file) => file.needsHuman) : [];
  const denied = access.data?._tag === "denied" ? access.data.reason : null;
  const pushing = command.isPending && command.variables === "push";
  const error = command.error ?? copy.error ?? access.error;
  return (
    <div className="mt-4 border-t border-border/60 pt-3">
      {held.length > 0 && (
        <p role="status" className="mb-2 text-xs text-warning-foreground">
          {plural(held.length, "file")} {held.length === 1 ? "needs" : "need"} you: prkit kept the
          base branch's side of {held.map((file) => file.path).join(", ")}. Check{" "}
          {held.length === 1 ? "it" : "them"} before you push. prkit never pushes this
          automatically.
        </p>
      )}
      {rebase && (
        <p role="status" className="mb-2 text-xs text-muted-foreground">
          A rebase rewrites the branch, so this is a force-push with a lease: it fails if anyone
          pushed since prkit fetched.
        </p>
      )}
      {denied !== null && (
        <p role="status" className="mb-2 text-xs text-muted-foreground">
          {denied} Copy the patch and apply it where you can push.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={command.isPending || access.isPending || denied !== null || revising}
          onClick={() => command.mutate("push")}
        >
          <ButtonLabel
            shown={pushing ? "pushing" : "push"}
            labels={{ push: rebase ? "Force-push with lease" : "Push", pushing: "Pushing…" }}
          />
        </Button>
        {turn.work._tag !== "revert" && (
          <Button
            size="sm"
            variant="outline"
            disabled={command.isPending || revising}
            onClick={() => setRevising(true)}
          >
            Ask the agent to change
          </Button>
        )}
        <Button
          size="sm"
          variant={denied !== null ? "outline" : "ghost"}
          disabled={copy.isPending}
          onClick={() => copy.mutate()}
        >
          <ButtonLabel
            shown={copy.isPending ? "copying" : "copy"}
            labels={{ copy: "Copy patch", copying: "Copying…" }}
          />
        </Button>
        <Button
          size="sm"
          variant="ghost-destructive"
          className="ml-auto"
          disabled={command.isPending}
          onClick={() => command.mutate("discard")}
        >
          Discard
        </Button>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-xs text-error-foreground">
          {error.message}
        </p>
      )}
      {revising && <ReviseForm prKey={detail.key} turn={turn} onDone={() => setRevising(false)} />}
    </div>
  );
}
