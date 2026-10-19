import {
  type EffectiveFocusArea,
  type FocusSection,
  GuideItemId,
  type GuideScope,
} from "@prkit/contracts";
import { PlusIcon, XIcon } from "lucide-react";
import { useEffect } from "react";
import { Controller, useFieldArray, useForm, useWatch } from "react-hook-form";

import { Button } from "~/components/ui/button";

import { DanglingOverrides } from "./DanglingOverrides";
import { FOCUS_SUGGESTIONS } from "./guidePresets";
import { InheritedItemRow } from "./InheritedItemRow";
import { InheritedItems } from "./InheritedItems";
import type { OverrideChoice } from "./OverrideControl";
import { SaveProblem } from "./SaveProblem";
import { useSaveGuideSection } from "./useSaveGuideSection";

interface Values {
  /** The version the form was loaded with; a newer one on the server refuses the save. */
  version: number;
  areas: Array<{ itemId: GuideItemId | null; label: string; question: string }>;
  /** Inherited items this scope switches; an untouched one stays undefined (inherit). */
  overrides: Partial<Record<string, OverrideChoice>>;
}

const toValues = (section: FocusSection): Values => ({
  version: section.version,
  areas: section.areas.map((area) => ({
    itemId: area.id,
    label: area.label,
    question: area.question,
  })),
  overrides: Object.fromEntries(section.overrides.map((entry) => [entry.itemId, entry.value])),
});

const inputClass =
  "h-8 min-w-0 rounded-md border border-input bg-background px-2.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring aria-invalid:border-error";

/**
 * One scope's focus areas: questions the guide must answer, each with a verdict.
 * Inherited areas can be switched on or off here; to reword one, switch it off
 * and add your own.
 */
export function FocusAreasEditor({
  scope,
  scopeLabel,
  section,
  inherited,
  onReload,
}: {
  scope: GuideScope;
  scopeLabel: string;
  section: FocusSection;
  inherited: ReadonlyArray<EffectiveFocusArea>;
  onReload: () => void;
}) {
  const save = useSaveGuideSection("Focus areas");
  const form = useForm<Values>({ defaultValues: toValues(section) });
  const areas = useFieldArray({ control: form.control, name: "areas" });
  const { isDirty, errors } = form.formState;
  useEffect(() => {
    if (!isDirty) form.reset(toValues(section));
  }, [section, isDirty, form]);
  const overrides = useWatch({ control: form.control, name: "overrides" });
  const labels = new Set(
    useWatch({ control: form.control, name: "areas" }).map((area) =>
      area.label.trim().toLowerCase(),
    ),
  );
  const known = new Set(inherited.map((area) => area.id));
  const dangling = Object.keys(overrides).filter(
    (id) => !known.has(GuideItemId.make(id)) && overrides[id] !== "inherit",
  );
  const choiceOf = (id: string): OverrideChoice => overrides[id] ?? "inherit";
  const offCount = inherited.filter((area) => {
    const choice = choiceOf(area.id);
    return choice === "inherit" ? !area.active : choice === "off";
  }).length;

  const submit = form.handleSubmit((values) =>
    save.mutate(
      {
        scope,
        expectedVersion: values.version,
        edit: {
          _tag: "focus",
          areas: values.areas.map((area) => ({
            id: area.itemId,
            label: area.label.trim(),
            question: area.question.trim(),
          })),
          overrides: Object.entries(values.overrides).flatMap(([itemId, value]) =>
            value === "on" || value === "off" ? [{ itemId: GuideItemId.make(itemId), value }] : [],
          ),
        },
      },
      { onSuccess: (saved) => form.reset(toValues(saved.focus)) },
    ),
  );
  const reload = () => {
    save.reset();
    form.reset(toValues(section));
    onReload();
  };
  const suggestions = FOCUS_SUGGESTIONS.filter(
    (suggestion) =>
      !labels.has(suggestion.label.toLowerCase()) &&
      !inherited.some((area) => area.label.toLowerCase() === suggestion.label.toLowerCase()),
  );

  return (
    <form
      noValidate
      aria-label={`${scopeLabel} focus areas`}
      onSubmit={(event) => {
        // In the composer this form sits in a popover inside the composer's own form;
        // React bubbles submit through portals, which would start a guide.
        event.stopPropagation();
        void submit(event);
      }}
      className="space-y-3"
    >
      <div>
        <h4 className="text-sm">Focus areas</h4>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Questions every guide answers, each with a verdict: notable (with the chapter to read),
          nothing notable, or not assessed and why. prkit checks every area gets an answer, not that
          the answer is right.
        </p>
      </div>
      <InheritedItems noun="focus areas" total={inherited.length} off={offCount}>
        {inherited.map((area) => (
          <Controller
            key={area.id}
            control={form.control}
            name={`overrides.${area.id}`}
            render={({ field }) => (
              <InheritedItemRow
                title={area.label}
                detail={area.question}
                scope={area.scope}
                parent={area}
                choice={field.value ?? "inherit"}
                onChoice={(choice) => field.onChange(choice)}
                disabled={save.isPending}
              />
            )}
          />
        ))}
      </InheritedItems>
      <DanglingOverrides
        ids={dangling}
        noun="focus areas"
        disabled={save.isPending}
        onRemove={(id) => form.setValue(`overrides.${id}`, "inherit", { shouldDirty: true })}
      />
      {areas.fields.length === 0 ? (
        <p role="status" className="text-xs text-muted-foreground">
          {scope._tag === "global" ? "No focus areas yet." : "No focus areas of its own yet."}
        </p>
      ) : (
        <ul aria-label={`${scopeLabel} focus areas`} className="space-y-2">
          {areas.fields.map((field, index) => {
            const labelError = errors.areas?.[index]?.label;
            const questionError = errors.areas?.[index]?.question;
            const name = field.label === "" ? `focus area ${index + 1}` : field.label;
            return (
              <li key={field.id} className="space-y-1">
                <div className="flex items-center gap-1.5">
                  <input
                    type="text"
                    autoComplete="off"
                    placeholder="Security"
                    aria-label={`Label of ${name}`}
                    aria-invalid={labelError !== undefined}
                    disabled={save.isPending}
                    className={`${inputClass} w-40 shrink-0`}
                    {...form.register(`areas.${index}.label`, {
                      validate: (value, all) => {
                        const label = value.trim();
                        if (label === "") return "Give the area a short label.";
                        if (label.length > 60) return "Keep the label under 60 characters.";
                        return all.areas.filter(
                          (area) => area.label.trim().toLowerCase() === label.toLowerCase(),
                        ).length > 1
                          ? "Another focus area has this label."
                          : true;
                      },
                    })}
                  />
                  <input
                    type="text"
                    autoComplete="off"
                    placeholder="What should the guide answer?"
                    aria-label={`Question of ${name}`}
                    aria-invalid={questionError !== undefined}
                    disabled={save.isPending}
                    className={`${inputClass} flex-1`}
                    {...form.register(`areas.${index}.question`, {
                      validate: (value) =>
                        value.trim() === ""
                          ? "Ask the question the guide should answer."
                          : value.trim().length > 300
                            ? "Keep the question under 300 characters."
                            : true,
                    })}
                  />
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label={`Remove ${name}`}
                    disabled={save.isPending}
                    onClick={() => areas.remove(index)}
                  >
                    <XIcon />
                  </Button>
                </div>
                {(labelError?.message ?? questionError?.message) !== undefined && (
                  <p role="alert" className="text-xs text-error-foreground">
                    {labelError?.message ?? questionError?.message}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          size="xs"
          variant="outline"
          disabled={save.isPending}
          onClick={() => areas.append({ itemId: null, label: "", question: "" })}
        >
          <PlusIcon />
          Add focus area
        </Button>
        {suggestions.map((suggestion) => (
          <Button
            key={suggestion.label}
            size="xs"
            variant="ghost-muted"
            aria-label={`Add the ${suggestion.label} focus area`}
            disabled={save.isPending}
            onClick={() =>
              areas.append({
                itemId: null,
                label: suggestion.label,
                question: suggestion.question,
              })
            }
          >
            <PlusIcon />
            {suggestion.label}
          </Button>
        ))}
      </div>
      {isDirty && (
        <div className="flex items-center gap-2">
          <Button type="submit" size="sm" disabled={save.isPending}>
            {save.isPending ? "Saving…" : "Save focus areas"}
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
