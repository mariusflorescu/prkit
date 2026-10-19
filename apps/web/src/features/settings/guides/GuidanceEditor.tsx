import type {
  EffectiveGuidance,
  GuidanceMode,
  GuidanceSection,
  GuideScope,
} from "@prkit/contracts";
import { useEffect } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";

import { Button } from "~/components/ui/button";
import { ButtonLabel } from "~/components/ui/button-label";

import { GuidanceModeControl } from "./GuidanceModeControl";
import { InheritedGuidance } from "./InheritedGuidance";
import { SaveProblem } from "./SaveProblem";
import { useSaveGuideSection } from "./useSaveGuideSection";

interface Values {
  version: number;
  text: string;
  mode: GuidanceMode;
}

const toValues = (section: GuidanceSection): Values => ({
  version: section.version,
  text: section.text,
  mode: section.mode,
});

/** One scope's free-form guidance. Below Global it can add to the guidance above or replace it. */
export function GuidanceEditor({
  scope,
  scopeLabel,
  section,
  inherited,
  onReload,
}: {
  scope: GuideScope;
  scopeLabel: string;
  section: GuidanceSection;
  /** Blocks of less specific scopes, as they stand above this one. */
  inherited: ReadonlyArray<EffectiveGuidance>;
  onReload: () => void;
}) {
  const save = useSaveGuideSection("Guidance");
  const form = useForm<Values>({ defaultValues: toValues(section) });
  const { isDirty, errors } = form.formState;
  useEffect(() => {
    if (!isDirty) form.reset(toValues(section));
  }, [section, isDirty, form]);
  const mode = useWatch({ control: form.control, name: "mode" });
  const submit = form.handleSubmit((values) =>
    save.mutate(
      {
        scope,
        expectedVersion: values.version,
        edit: { _tag: "guidance", text: values.text.trim(), mode: values.mode },
      },
      { onSuccess: (saved) => form.reset(toValues(saved.guidance)) },
    ),
  );
  const reload = () => {
    save.reset();
    form.reset(toValues(section));
    onReload();
  };
  const inherits = scope._tag !== "global";
  return (
    <form
      noValidate
      aria-label={`${scopeLabel} guidance`}
      onSubmit={(event) => {
        // In the composer this form sits in a popover inside the composer's own form;
        // React bubbles submit through portals, which would start a guide.
        event.stopPropagation();
        void submit(event);
      }}
      className="space-y-3"
    >
      <div>
        <h4 className="text-sm">Guidance</h4>
        <p className="mt-0.5 text-xs text-muted-foreground">
          What to emphasize, in your words. The agent gets every block labelled by scope, and when
          two conflict the more specific one wins: the pull request over the repository over Global.
          Guidance can't change the guide's format or the writing rules.
        </p>
      </div>
      {inherits && <InheritedGuidance blocks={inherited} replaced={mode === "replace"} />}
      <textarea
        aria-label={`${scopeLabel} guidance`}
        placeholder={
          inherits
            ? "Guidance for this repository's guides (optional)"
            : "Guidance for every guide (optional)"
        }
        rows={3}
        disabled={save.isPending}
        aria-invalid={errors.text !== undefined}
        className="block w-full resize-y rounded-md border border-input bg-background px-2.5 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring aria-invalid:border-error"
        {...form.register("text", {
          validate: (value) =>
            value.trim().length > 4000 ? "Keep the guidance under 4000 characters." : true,
        })}
      />
      {errors.text?.message !== undefined && (
        <p role="alert" className="text-xs text-error-foreground">
          {errors.text.message}
        </p>
      )}
      {inherits && (
        <Controller
          control={form.control}
          name="mode"
          render={({ field }) => (
            <GuidanceModeControl
              label={`How ${scopeLabel.toLowerCase()} guidance combines with the guidance above`}
              value={field.value}
              onChange={field.onChange}
              disabled={save.isPending}
            />
          )}
        />
      )}
      {isDirty && (
        <div className="flex items-center gap-2">
          <Button type="submit" size="sm" disabled={save.isPending}>
            <ButtonLabel
              shown={save.isPending ? "saving" : "save"}
              labels={{ save: "Save guidance", saving: "Saving…" }}
            />
          </Button>
          <Button
            size="sm"
            variant="ghost-muted"
            disabled={save.isPending}
            onClick={() => {
              save.reset();
              form.reset(toValues(section));
            }}
          >
            Discard
          </Button>
        </div>
      )}
      {save.error !== null && (
        <SaveProblem error={save.error} onRetry={() => void submit()} onReload={reload} />
      )}
    </form>
  );
}
