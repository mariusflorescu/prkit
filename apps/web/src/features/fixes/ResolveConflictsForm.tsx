import type { AgentSelection, ConflictStrategy, PullRequestDetail } from "@prkit/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useForm, useWatch } from "react-hook-form";

import { Button } from "~/components/ui/button";
import { resolveConflicts } from "~/rpc/client";

import { FixAgentPicker } from "./FixAgentPicker";
import { storeFixer } from "./fixerCache";
import { PushNotice } from "./PushNotice";
import { ScriptAccessNotice } from "./ScriptAccessNotice";
import { useFixAgent } from "./useFixAgent";

interface Values {
  strategy: ConflictStrategy;
  agent: AgentSelection | null;
}

/**
 * Asks the fix agent to resolve the PR's conflicts: merge the base in (a normal
 * push), or, on your own PR, rebase onto it (always a manual force-push with lease).
 */
export function ResolveConflictsForm({
  detail,
  onDone,
}: {
  detail: PullRequestDetail;
  onDone: () => void;
}) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const login = detail.accountId.slice(detail.accountId.indexOf("/") + 1);
  const own = detail.author?.login === login;
  const form = useForm<Values>({ defaultValues: { strategy: "merge", agent: null } });
  const chosen = useWatch({ control: form.control, name: "agent" });
  const agent = useFixAgent(detail.key, chosen);
  const start = useMutation({
    mutationFn: (values: Values) => {
      if (agent.selection === null) return Promise.reject(new Error("Pick an agent first."));
      return resolveConflicts({
        key: detail.key,
        accountId: detail.accountId,
        agent: agent.selection,
        strategy: values.strategy,
      });
    },
    onSuccess: (snapshot) => {
      storeFixer(client, snapshot);
      onDone();
      void navigate({
        to: "/pr/$host/$owner/$repo/$number",
        params: {
          host: detail.ref.host,
          owner: detail.ref.owner,
          repo: detail.ref.repo,
          number: String(detail.ref.number),
        },
        search: { account: detail.accountId, tab: "fixes" },
      });
    },
  });
  const submit = form.handleSubmit((values) => start.mutate(values));
  return (
    <form
      noValidate
      aria-label="Resolve conflicts"
      onSubmit={(event) => void submit(event)}
      className="space-y-3"
    >
      <fieldset className="space-y-2" disabled={start.isPending}>
        <legend className="sr-only">How to resolve</legend>
        <label className="flex cursor-pointer items-start gap-2 text-sm">
          <input type="radio" value="merge" className="mt-1" {...form.register("strategy")} />
          <span>
            <span className="block font-medium">Merge {detail.baseBranch} into this branch</span>
            <span className="block text-xs text-muted-foreground">
              A merge commit on top, like GitHub's own Resolve conflicts. A normal push.
            </span>
          </span>
        </label>
        <label className="flex cursor-pointer items-start gap-2 text-sm has-disabled:cursor-not-allowed has-disabled:opacity-60">
          <input
            type="radio"
            value="rebase"
            className="mt-1"
            disabled={!own}
            {...form.register("strategy")}
          />
          <span>
            <span className="block font-medium">Rebase onto {detail.baseBranch}</span>
            <span className="block text-xs text-muted-foreground">
              {own
                ? "Rewrites the branch's history. You push it yourself, with a lease."
                : "Only on your own pull requests, since it rewrites the branch."}
            </span>
          </span>
        </label>
      </fieldset>
      <FixAgentPicker
        agent={agent}
        disabled={start.isPending}
        onChange={(selection) => form.setValue("agent", selection)}
      />
      <PushNotice detail={detail} />
      <ScriptAccessNotice detail={detail} />
      {agent.problem !== null && (
        <p role="status" className="text-xs text-muted-foreground">
          {agent.problem}
        </p>
      )}
      {start.error && (
        <p role="alert" className="text-xs text-error-foreground">
          {start.error.message}
        </p>
      )}
      <div className="flex items-center justify-between gap-2">
        <Button
          size="xs"
          variant="link"
          render={<a href={`${detail.url}/conflicts`} target="_blank" rel="noreferrer" />}
        >
          Resolve on GitHub instead
        </Button>
        <Button
          type="submit"
          size="sm"
          disabled={start.isPending || agent.selection === null || agent.problem !== null}
        >
          {start.isPending ? "Starting…" : "Resolve with the agent"}
        </Button>
      </div>
    </form>
  );
}
