import {
  type AgentSelection,
  type LocalReview,
  pinnedDamage,
  selectionProblem,
  sessionSelection,
} from "@prkit/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm, useWatch } from "react-hook-form";

import { GenerateGuideButton } from "~/components/review/GenerateGuideButton";
import { GuideSetupAgent } from "~/components/review/GuideSetupAgent";
import { GuideSetupNotice } from "~/components/review/GuideSetupNotice";
import { GuideSetupRow } from "~/components/review/GuideSetupRow";
import { getAgentCatalog } from "~/rpc/client";
import { agentCatalogQuery, guideSettingsQuery } from "~/rpc/queries";

import type { useLocalReviewActions } from "./useLocalReviewActions";

const NO_AGENT =
  "No agent is ready to write guides. Sign one in under Settings > Agents, then check again.";

/** Run again with an agent of the user's choosing, the review's own picked first. */
export function LocalRunAgainForm({
  review,
  generate,
  onStarted,
}: {
  review: LocalReview;
  generate: ReturnType<typeof useLocalReviewActions>["generate"];
  onStarted: () => void;
}) {
  const client = useQueryClient();
  const catalog = useQuery(agentCatalogQuery);
  const settings = useQuery(guideSettingsQuery);
  const checkAgain = useMutation({
    mutationFn: () => getAgentCatalog(true),
    onSuccess: (data) => client.setQueryData(agentCatalogQuery.queryKey, data),
  });
  const form = useForm<{ agent: AgentSelection | null }>({ defaultValues: { agent: null } });
  const picked = useWatch({ control: form.control, name: "agent" });
  const own =
    review.model === null
      ? null
      : {
          instance: review.instance,
          kind: review.provider,
          model: review.model,
          options: review.modelOptions,
        };
  const selection =
    picked ??
    (catalog.data === undefined || settings.data === undefined
      ? null
      : sessionSelection(catalog.data, own, settings.data.defaultAgent));
  // A review on a setting prkit can't read stays on it, a review from before models included.
  const pinned =
    picked === null && catalog.data !== undefined
      ? pinnedDamage(catalog.data, review.instance, review.provider)
      : undefined;
  const problem =
    pinned?.message ??
    (catalog.data === undefined || selection === null
      ? null
      : selectionProblem(catalog.data, selection));
  const submit = form.handleSubmit(() => {
    if (selection === null || problem !== null) return;
    generate.mutate({ agent: selection }, { onSuccess: onStarted });
  });
  return (
    <form
      noValidate
      aria-label="Run again"
      onSubmit={(event) => void submit(event)}
      className="min-w-0 text-left"
    >
      <div className="py-1.5">
        <GuideSetupRow label="Agent">
          <GuideSetupAgent
            catalog={catalog.data}
            loading={catalog.isPending || settings.isPending}
            error={catalog.error ?? settings.error}
            onRetry={() => {
              void catalog.refetch();
              void settings.refetch();
            }}
            selection={selection}
            onChange={(next) => form.setValue("agent", next)}
            onCheckAgain={() => checkAgain.mutate()}
            checking={checkAgain.isPending}
          />
        </GuideSetupRow>
      </div>
      <div className="flex items-center gap-3 border-t border-border/60 px-3 py-2">
        <div className="min-w-0 flex-1">
          <GuideSetupNotice
            blocked={null}
            failure={generate.error}
            checkFailure={checkAgain.error}
            problem={
              problem ?? (selection === null && catalog.data !== undefined ? NO_AGENT : null)
            }
            checking={checkAgain.isPending}
            pending={generate.isPending}
            onRetry={() => void submit()}
            onCheckAgain={() => checkAgain.mutate()}
            fallback={
              <p className="text-xs text-muted-foreground">
                A new snapshot of your changes, then a new revision if anything changed.
              </p>
            }
          />
        </div>
        <GenerateGuideButton
          label="Run again"
          pending={generate.isPending}
          disabled={selection === null || problem !== null || generate.isPending}
          shortcut={false}
          describedBy={problem !== null ? "generate-blocked" : undefined}
        />
      </div>
    </form>
  );
}
