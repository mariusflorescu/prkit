import {
  everythingSkippedMessage,
  type PullRequestDetail,
  type Review,
  selectionProblem,
  sessionSelection,
} from "@prkit/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useForm, useWatch } from "react-hook-form";

import { getAgentCatalog } from "~/rpc/client";
import {
  agentCatalogQuery,
  guideSettingsQuery,
  pullRequestStackQuery,
  reviewFeedQuery,
} from "~/rpc/queries";
import { layerGuide, layerKey } from "~/features/stack/stackPresentation";
import { cn } from "~/lib/utils";

import { GuideSettingsLine } from "./config/GuideSettingsLine";
import { useGuideConfigPreview } from "./config/useGuideConfigPreview";
import { registerComposer } from "./composerRegistry";
import { chosenLayers, type ComposerValues } from "./composerValues";
import { GenerateGuideButton } from "./GenerateGuideButton";
import { GuideFocusField } from "./GuideFocusField";
import { GuideSetupAgent } from "./GuideSetupAgent";
import { GuideSetupNotice } from "./GuideSetupNotice";
import { GuideSetupRow } from "./GuideSetupRow";
import { StackScopeControl } from "./StackScopeControl";
import { TypicalDuration } from "./TypicalDuration";
import { useReviewActions } from "./useReviewActions";
import { useStartStackGuides } from "./useStartStackGuides";

const NO_AGENT =
  "No agent is ready to write guides. Sign one in under Settings > Agents, then check again.";

/**
 * Sets a guide up like a document, not a chat: who writes it, an optional focus (this
 * PR's guidance), the PR's guide settings, which layers of a stack, then one Generate
 * (Cmd+G). Cmd+G always writes this PR's guide, whatever the stack scope says.
 */
export function GuideSetup({
  detail,
  review,
  submitLabel,
  frame,
  onStarted,
}: {
  detail: PullRequestDetail;
  review: Review | null;
  submitLabel: string;
  /** `card` on the Guide tab; `bare` inside the Generate again popover, which frames it. */
  frame: "card" | "bare";
  onStarted?: () => void;
}) {
  const client = useQueryClient();
  const catalog = useQuery(agentCatalogQuery);
  const settings = useQuery(guideSettingsQuery);
  const checkAgain = useMutation({
    mutationFn: () => getAgentCatalog(true),
    onSuccess: (data) => client.setQueryData(agentCatalogQuery.queryKey, data),
  });
  const { generate } = useReviewActions(detail.key);
  const stackGuides = useStartStackGuides();
  const preview = useGuideConfigPreview(detail);
  const stack = useQuery({
    ...pullRequestStackQuery(detail.key, detail.accountId),
    enabled: detail.stack !== null,
  });
  const feed = useQuery(reviewFeedQuery).data;
  // Which layers already have a guide is known only from a feed read now, so a stack scope
  // starts nothing until then.
  const reviews = feed?._tag === "live" ? feed.reviews : null;
  const form = useForm<ComposerValues>({
    defaultValues: {
      guidance: "",
      guidanceMode: "append",
      agent: null,
      scope: "this",
      layers: [],
      regenerate: false,
    },
  });
  const saved = preview.config.data?.pullRequest.guidance;
  // The PR's saved guidance fills the focus once it loads, unless the user already typed.
  useEffect(() => {
    if (saved === undefined) return;
    form.reset(
      { ...form.getValues(), guidance: saved.text, guidanceMode: saved.mode },
      {
        keepDirtyValues: true,
      },
    );
  }, [saved, form]);
  const guidance = useWatch({ control: form.control, name: "guidance" });
  const guidanceMode = useWatch({ control: form.control, name: "guidanceMode" });
  const picked = useWatch({ control: form.control, name: "agent" });
  const scope = useWatch({ control: form.control, name: "scope" });
  const ticked = useWatch({ control: form.control, name: "layers" });
  const regenerate = useWatch({ control: form.control, name: "regenerate" });
  const stacked = stack.data != null && scope !== "this";
  // The layers a stack scope would start: running ones never, written ones only on Regenerate.
  const starting = chosenLayers(stack.data ?? null, scope, ticked).filter((layer) => {
    const guide = layerGuide(reviews?.get(layerKey(detail.ref, layer)));
    return guide === "none" || (guide === "ready" && regenerate);
  });
  const own =
    review?.model == null
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
  const problem =
    catalog.data === undefined || selection === null
      ? null
      : selectionProblem(catalog.data, selection);
  const blocked =
    preview.everythingSkipped && preview.skipped !== null
      ? everythingSkippedMessage(
          preview.skipped.map((entry) => ({
            reasons: entry.decision.sides.flatMap((side) =>
              side.winner === null ? [] : [side.winner],
            ),
          })),
        )
      : null;
  const pending = generate.isPending || stackGuides.pending;
  const ready =
    selection !== null &&
    problem === null &&
    saved !== undefined &&
    (stacked ? reviews !== null && starting.length > 0 : blocked === null) &&
    !pending;
  const start = (values: ComposerValues, wholeScope: boolean) => {
    if (selection === null || problem !== null || saved === undefined) return;
    const text = values.guidance.trim();
    const changed = text !== saved.text || values.guidanceMode !== saved.mode;
    const guidance = changed
      ? { guidance: { expectedVersion: saved.version, text, mode: values.guidanceMode } }
      : {};
    const [first, ...rest] = starting.map((layer) => layer.number);
    if (wholeScope && stacked) {
      if (first === undefined) return;
      stackGuides.start({
        key: detail.key,
        accountId: detail.accountId,
        layers: [first, ...rest],
        regenerate: values.regenerate,
        agent: selection,
        ...guidance,
      });
      return;
    }
    if (blocked !== null) return;
    generate.mutate(
      { accountId: detail.accountId, agent: selection, ...guidance },
      { onSuccess: () => onStarted?.() },
    );
  };
  const submit = form.handleSubmit((values) => start(values, true));
  const submitThis = form.handleSubmit((values) => start(values, false));
  useEffect(() => registerComposer(detail.key, () => void submitThis()), [detail.key, submitThis]);
  return (
    <form
      noValidate
      aria-label="Start a guide"
      onSubmit={(event) => void submit(event)}
      className={cn(
        "min-w-0 text-left",
        frame === "card" && "rounded-lg border border-border bg-card shadow-xs/5",
      )}
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
        <GuideSetupRow label="Focus">
          <GuideFocusField
            form={form}
            stacked={stacked}
            hasSaved={saved !== undefined && saved.text !== ""}
            loading={saved === undefined && !preview.config.isError}
            onSubmit={() => void submit()}
          />
        </GuideSetupRow>
        <GuideSetupRow label="Settings">
          <GuideSettingsLine
            pullRequest={detail.key}
            preview={preview}
            guidance={guidance}
            mode={guidanceMode}
            onMode={(mode) => form.setValue("guidanceMode", mode, { shouldDirty: true })}
          />
        </GuideSetupRow>
        {detail.stack !== null && stack.data != null && (
          <GuideSetupRow label="Write for">
            <StackScopeControl form={form} stack={stack.data} pullRequest={detail.ref} />
          </GuideSetupRow>
        )}
      </div>
      <div className="flex items-center gap-3 border-t border-border/60 px-3 py-2">
        <div className="min-w-0 flex-1">
          <GuideSetupNotice
            blocked={stacked ? null : blocked}
            failure={generate.error ?? stackGuides.error}
            checkFailure={checkAgain.error}
            problem={
              problem ?? (selection === null && catalog.data !== undefined ? NO_AGENT : null)
            }
            checking={checkAgain.isPending}
            pending={pending}
            onRetry={() => void submit()}
            onCheckAgain={() => checkAgain.mutate()}
            fallback={<TypicalDuration detail={detail} instance={selection?.instance ?? null} />}
          />
        </div>
        <GenerateGuideButton
          label={
            pending
              ? "Starting…"
              : stacked
                ? `Generate ${starting.length} guide${starting.length === 1 ? "" : "s"}`
                : submitLabel
          }
          disabled={!ready}
          shortcut={!stacked}
          describedBy={problem !== null ? "generate-blocked" : undefined}
        />
      </div>
    </form>
  );
}
