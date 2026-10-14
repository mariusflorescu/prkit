import type { PullRequestRef, PullRequestStack, ReviewFeedEntry } from "@prkit/contracts";
import { useWatch, type UseFormReturn } from "react-hook-form";

import { Button } from "~/components/ui/button";
import { LAYER_GUIDE_LABELS, layerGuide, layerKey } from "~/features/stack/stackPresentation";
import { pullRequestState } from "~/lib/pullRequestState";
import { cn } from "~/lib/utils";

import { chosenLayers, type ComposerValues, type GuideScopeChoice } from "./composerValues";

/**
 * This PR, the whole stack, or chosen layers. A layer that already has a guide is
 * skipped unless Regenerate is ticked; closed and merged layers can't be chosen.
 */
export function StackScopeControl({
  form,
  stack,
  pullRequest,
  reviews,
}: {
  form: UseFormReturn<ComposerValues>;
  stack: PullRequestStack;
  pullRequest: PullRequestRef;
  reviews: ReadonlyMap<string, ReviewFeedEntry> | undefined;
}) {
  const scope = useWatch({ control: form.control, name: "scope" });
  const ticked = useWatch({ control: form.control, name: "layers" });
  const open = stack.layers.filter((layer) => layer.state === "open");
  const guideOf = (number: number) => layerGuide(reviews?.get(layerKey(pullRequest, { number })));
  const chosen = chosenLayers(stack, scope, ticked);
  const written = chosen.filter((layer) => guideOf(layer.number) === "ready");
  const choices: ReadonlyArray<{ value: GuideScopeChoice; label: string }> = [
    { value: "this", label: "This PR" },
    { value: "stack", label: `Whole stack (${open.length} PR${open.length === 1 ? "" : "s"})` },
    { value: "layers", label: "Choose layers" },
  ];
  return (
    <div className="min-w-0 flex-1 space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <div
          role="radiogroup"
          aria-label="Write guides for"
          className="flex w-fit items-center gap-0.5 rounded-md border border-border p-0.5"
        >
          {choices.map((choice) => (
            <Button
              key={choice.value}
              role="radio"
              aria-checked={scope === choice.value}
              size="micro"
              variant={scope === choice.value ? "secondary" : "ghost-muted"}
              onClick={() => {
                form.setValue("scope", choice.value, { shouldDirty: true });
                if (choice.value === "layers" && ticked.length === 0)
                  form.setValue("layers", [pullRequest.number]);
              }}
            >
              {choice.label}
            </Button>
          ))}
        </div>
        {scope !== "this" && written.length > 0 && (
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <input type="checkbox" {...form.register("regenerate")} />
            Regenerate {written.length === 1 ? "the guide that exists" : "guides that exist"}
          </label>
        )}
      </div>
      {scope === "layers" && (
        <fieldset aria-label="Layers to write guides for" className="space-y-0.5">
          {stack.layers.map((layer) => {
            const state = pullRequestState(layer);
            const guide = guideOf(layer.number);
            const disabled = layer.state !== "open";
            return (
              <label
                key={layer.number}
                className={cn(
                  "flex min-h-7 items-center gap-2 rounded px-1.5 text-xs",
                  disabled ? "opacity-64" : "cursor-pointer hover:bg-muted",
                )}
              >
                <input
                  type="checkbox"
                  aria-label={`Layer ${layer.position}: #${layer.number} ${layer.title}`}
                  checked={!disabled && ticked.includes(layer.number)}
                  disabled={disabled}
                  onChange={(event) =>
                    form.setValue(
                      "layers",
                      event.target.checked
                        ? [...ticked, layer.number]
                        : ticked.filter((number) => number !== layer.number),
                      { shouldDirty: true },
                    )
                  }
                />
                <span className="w-3 font-mono text-3xs text-muted-foreground/70 tabular-nums">
                  {layer.position}
                </span>
                <state.Icon aria-hidden className={cn("size-3.5 shrink-0", state.tone)} />
                <span className="shrink-0 font-mono text-2xs text-muted-foreground">
                  #{layer.number}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {layer.title}
                  {layer.number === pullRequest.number && (
                    <span className="text-muted-foreground"> · this PR</span>
                  )}
                </span>
                <span className="shrink-0 text-2xs text-muted-foreground">
                  {disabled ? state.label : LAYER_GUIDE_LABELS[guide]}
                </span>
              </label>
            );
          })}
        </fieldset>
      )}
    </div>
  );
}
