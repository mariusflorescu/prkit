import type { AgentSelection, PullRequestDetail } from "@prkit/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useForm, useWatch } from "react-hook-form";

import { Button } from "~/components/ui/button";
import { ButtonLabel } from "~/components/ui/button-label";
import { toastManager } from "~/components/ui/toast";
import { sendToAgent } from "~/rpc/client";
import { pendingCommentsQuery } from "~/rpc/queries";

import { runsOnCursor } from "./cursorFixes";
import { FixAgentPicker } from "./FixAgentPicker";
import { FixCandidateRow } from "./FixCandidateRow";
import type { FixCandidate } from "./fixCandidates";
import { storeFixer } from "./fixerCache";
import { plural } from "./fixPresentation";
import { PushNotice } from "./PushNotice";
import { ScriptAccessNotice } from "./ScriptAccessNotice";
import { useFixAgent } from "./useFixAgent";

interface Values {
  picked: ReadonlyArray<string>;
  note: string;
  replyAfterPush: boolean;
  /** Null until the user picks: the session's agent, else the default. */
  agent: AgentSelection | null;
}

/** The "Send to agent" form itself, once the comments it offers are loaded. */
export function SendToAgentFields({
  detail,
  candidates,
  initial,
  own,
  onDone,
}: {
  detail: PullRequestDetail;
  candidates: ReadonlyArray<FixCandidate>;
  initial: ReadonlyArray<string>;
  own: boolean;
  onDone: () => void;
}) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const form = useForm<Values>({
    defaultValues: { picked: initial, note: "", replyAfterPush: own, agent: null },
  });
  const picked = useWatch({ control: form.control, name: "picked" });
  const chosen = useWatch({ control: form.control, name: "agent" });
  const agent = useFixAgent(detail.key, chosen);
  const send = useMutation({
    mutationFn: (values: Values) => {
      const targets = candidates
        .filter((candidate) => values.picked.includes(candidate.id))
        .map((candidate) => candidate.target);
      const [first, ...rest] = targets;
      if (first === undefined || agent.selection === null)
        return Promise.reject(new Error("Pick at least one comment."));
      return sendToAgent({
        key: detail.key,
        accountId: detail.accountId,
        agent: agent.selection,
        targets: [first, ...rest],
        note: values.note.trim() === "" ? null : values.note.trim(),
        replyAfterPush: values.replyAfterPush,
      });
    },
    onSuccess: (snapshot, values) => {
      storeFixer(client, snapshot);
      void client.invalidateQueries({
        queryKey: pendingCommentsQuery(detail.key, detail.accountId).queryKey,
      });
      const openFixes = () =>
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
      toastManager.add({
        type: "success",
        title: "Sent to the agent",
        description: plural(values.picked.length, "comment"),
        actionProps: { children: "Open Fixes", onClick: openFixes },
      });
      onDone();
    },
  });
  const submit = form.handleSubmit((values) => {
    if (values.picked.length === 0) {
      form.setError("picked", { message: "Pick at least one comment." });
      return;
    }
    send.mutate(values);
  });
  const toggle = (id: string, checked: boolean) => {
    form.clearErrors("picked");
    form.setValue("picked", checked ? [...picked, id] : picked.filter((entry) => entry !== id), {
      shouldDirty: true,
    });
  };
  const threadPicked = candidates.some(
    (candidate) => candidate.kind === "thread" && picked.includes(candidate.id),
  );
  const switching = agent.switching;
  return (
    <form
      noValidate
      aria-label="Send to agent"
      onSubmit={(event) => void submit(event)}
      className="mt-3 space-y-3"
    >
      <fieldset disabled={send.isPending}>
        <legend className="text-xs font-medium">Comments for the agent</legend>
        <ul aria-label="Comments for the agent" className="mt-1 max-h-52 overflow-y-auto">
          {candidates.map((candidate) => (
            <FixCandidateRow
              key={candidate.id}
              candidate={candidate}
              checked={picked.includes(candidate.id)}
              disabled={send.isPending}
              onChange={(checked) => toggle(candidate.id, checked)}
            />
          ))}
        </ul>
        {form.formState.errors.picked && (
          <p role="alert" className="text-xs text-error-foreground">
            {form.formState.errors.picked.message}
          </p>
        )}
      </fieldset>
      <textarea
        {...form.register("note")}
        rows={2}
        aria-label="Anything else the agent should know?"
        placeholder="Anything else the agent should know? (optional)"
        disabled={send.isPending}
        className="field-sizing-content block max-h-40 min-h-12 w-full resize-y rounded-md border border-input bg-background px-2.5 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <FixAgentPicker
        agent={agent}
        disabled={send.isPending}
        onChange={(selection) => form.setValue("agent", selection)}
      />
      {switching && (
        <p role="status" className="text-xs text-muted-foreground">
          A different agent starts a new conversation for this pull request.
        </p>
      )}
      {threadPicked && (
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" {...form.register("replyAfterPush")} />
          Reply on GitHub threads with what was fixed, once it's pushed
        </label>
      )}
      <PushNotice detail={detail} />
      {/* The scripts line takes two rows here, so its read landing moves nothing below it. */}
      <div className="min-h-8">
        <ScriptAccessNotice detail={detail} cursor={runsOnCursor(agent.catalog, agent.selection)} />
      </div>
      {agent.problem !== null && (
        <p role="status" className="text-xs text-muted-foreground">
          {agent.problem}
        </p>
      )}
      {send.error && (
        <p role="alert" className="text-xs text-error-foreground">
          {send.error.message} Your comments are still here.
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button
          type="submit"
          size="sm"
          disabled={send.isPending || agent.selection === null || agent.problem !== null}
        >
          <ButtonLabel
            shown={send.isPending ? "sending" : "send"}
            labels={{
              send: `Send ${plural(picked.length, "comment")} to agent`,
              sending: "Sending...",
            }}
          />
        </Button>
      </div>
    </form>
  );
}
