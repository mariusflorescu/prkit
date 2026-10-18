import {
  type EffectiveIgnoreRule,
  GuideItemId,
  type GuideScope,
  type IgnoreSection,
  ignorePatternProblem,
} from "@prkit/contracts";
import { PlusIcon, XIcon } from "lucide-react";
import { useEffect } from "react";
import { Controller, useFieldArray, useForm, useWatch } from "react-hook-form";

import { Button } from "~/components/ui/button";

import { DanglingOverrides } from "./DanglingOverrides";
import { IGNORE_PRESETS } from "./guidePresets";
import { InheritedItemRow } from "./InheritedItemRow";
import { InheritedItems } from "./InheritedItems";
import type { OverrideChoice } from "./OverrideControl";
import { PATH_RULE_COPY, type PathRuleKind } from "./pathRuleCopy";
import { SaveProblem } from "./SaveProblem";
import { useSaveGuideSection } from "./useSaveGuideSection";

interface Values {
  /** The version the form was loaded with; a newer one on the server refuses the save. */
  version: number;
  rules: Array<{ itemId: GuideItemId | null; pattern: string }>;
  /** Inherited items this scope switches; an untouched one stays undefined (inherit). */
  overrides: Partial<Record<string, OverrideChoice>>;
}

const toValues = (section: IgnoreSection): Values => ({
  version: section.version,
  rules: section.rules.map((rule) => ({ itemId: rule.id, pattern: rule.pattern })),
  overrides: Object.fromEntries(section.overrides.map((entry) => [entry.itemId, entry.value])),
});

/**
 * One scope's ignore rules, or its look-closely paths, which share the shape: its own
 * patterns in order, and inherit/on/off for the ones it inherits. The last matching
 * pattern decides; `!` leaves a file out.
 */
export function PathRulesEditor({
  kind,
  scope,
  scopeLabel,
  section,
  inherited,
  onReload,
}: {
  kind: PathRuleKind;
  scope: GuideScope;
  /** "Global", "Repository" or "This pull request", for names and messages. */
  scopeLabel: string;
  section: IgnoreSection;
  /** Rules from less specific scopes, as they stand above this one. */
  inherited: ReadonlyArray<EffectiveIgnoreRule>;
  onReload: () => void;
}) {
  const copy = PATH_RULE_COPY[kind];
  const presets = kind === "ignore" && scope._tag === "global";
  const save = useSaveGuideSection(copy.saved);
  const form = useForm<Values>({ defaultValues: toValues(section) });
  const rules = useFieldArray({ control: form.control, name: "rules" });
  const { isDirty, errors } = form.formState;
  // A clean form follows the server; an edited one keeps the version it was loaded with.
  useEffect(() => {
    if (!isDirty) form.reset(toValues(section));
  }, [section, isDirty, form]);
  const overrides = useWatch({ control: form.control, name: "overrides" });
  const patterns = new Set(
    useWatch({ control: form.control, name: "rules" }).map((rule) => rule.pattern.trim()),
  );
  const known = new Set(inherited.map((rule) => rule.id));
  const dangling = Object.keys(overrides).filter(
    (id) => !known.has(GuideItemId.make(id)) && overrides[id] !== "inherit",
  );
  const choiceOf = (id: string): OverrideChoice => overrides[id] ?? "inherit";
  const offCount = inherited.filter((rule) => {
    const choice = choiceOf(rule.id);
    return choice === "inherit" ? !rule.active : choice === "off";
  }).length;

  const submit = form.handleSubmit((values) =>
    save.mutate(
      {
        scope,
        expectedVersion: values.version,
        edit: {
          _tag: kind,
          rules: values.rules.map((rule) => ({ id: rule.itemId, pattern: rule.pattern.trim() })),
          overrides: Object.entries(values.overrides).flatMap(([itemId, value]) =>
            value === "on" || value === "off" ? [{ itemId: GuideItemId.make(itemId), value }] : [],
          ),
        },
      },
      { onSuccess: (saved) => form.reset(toValues(saved[kind])) },
    ),
  );
  const reload = () => {
    save.reset();
    form.reset(toValues(section));
    onReload();
  };

  return (
    <form
      noValidate
      aria-label={copy.form(scopeLabel)}
      onSubmit={(event) => {
        // In the composer this form sits in a popover inside the composer's own form;
        // React bubbles submit through portals, which would start a guide.
        event.stopPropagation();
        void submit(event);
      }}
      className="space-y-3"
    >
      <div>
        <h4 className="text-sm">{copy.title}</h4>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {copy.intro}{" "}
          {scope._tag === "repository" ? (
            "Patterns work as in Global."
          ) : (
            <>
              <code>name</code> matches a file or folder at any depth, <code>folder/</code>{" "}
              everything inside folders with that name, a pattern with a <code>/</code> in it starts
              at the repository root, <code>*</code> stays in one folder and <code>**</code> crosses
              folders. <code>!pattern</code> {copy.negation}
            </>
          )}{" "}
          The last {copy.order} that matches decides: Global first, then Repository, then the pull
          request.
        </p>
      </div>
      <InheritedItems noun={copy.noun} total={inherited.length} off={offCount}>
        {inherited.map((rule) => (
          <Controller
            key={rule.id}
            control={form.control}
            name={`overrides.${rule.id}`}
            render={({ field }) => (
              <InheritedItemRow
                title={rule.pattern}
                code
                scope={rule.scope}
                parent={rule}
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
        noun={copy.danglingNoun}
        disabled={save.isPending}
        onRemove={(id) => form.setValue(`overrides.${id}`, "inherit", { shouldDirty: true })}
      />
      {rules.fields.length === 0 ? (
        <p role="status" className="text-xs text-muted-foreground">
          {scope._tag === "global" ? copy.emptyGlobal : copy.emptyOwn}
        </p>
      ) : (
        <ul aria-label={copy.list(scopeLabel)} className="space-y-1.5">
          {rules.fields.map((field, index) => {
            const error = errors.rules?.[index]?.pattern;
            return (
              <li key={field.id}>
                <div className="flex items-center gap-1.5">
                  <input
                    type="text"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={copy.placeholder}
                    aria-label={copy.input(index + 1)}
                    aria-invalid={error !== undefined}
                    disabled={save.isPending}
                    className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2.5 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring aria-invalid:border-error"
                    {...form.register(`rules.${index}.pattern`, {
                      validate: (value, all) => {
                        const pattern = value.trim();
                        const problem = ignorePatternProblem(pattern);
                        if (problem !== null) return problem;
                        return all.rules.filter((rule) => rule.pattern.trim() === pattern).length >
                          1
                          ? "This pattern is already in the list."
                          : true;
                      },
                    })}
                  />
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label={copy.remove(
                      field.pattern === "" ? String(index + 1) : field.pattern,
                    )}
                    disabled={save.isPending}
                    onClick={() => rules.remove(index)}
                  >
                    <XIcon />
                  </Button>
                </div>
                {error?.message !== undefined && (
                  <p role="alert" className="mt-1 text-xs text-error-foreground">
                    {error.message}
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
          onClick={() => rules.append({ itemId: null, pattern: "" })}
        >
          <PlusIcon />
          {copy.add}
        </Button>
        {presets &&
          IGNORE_PRESETS.map((preset) => {
            const missing = preset.patterns.filter((pattern) => !patterns.has(pattern));
            return (
              <Button
                key={preset.name}
                size="xs"
                variant="ghost-muted"
                aria-label={`Add the ${preset.name} preset`}
                disabled={save.isPending || missing.length === 0}
                onClick={() => rules.append(missing.map((pattern) => ({ itemId: null, pattern })))}
              >
                <PlusIcon />
                {preset.name}
              </Button>
            );
          })}
      </div>
      {save.error !== null && (
        <SaveProblem error={save.error} onRetry={() => void submit()} onReload={reload} />
      )}
      {isDirty && (
        <div className="flex items-center gap-2">
          <Button type="submit" size="sm" disabled={save.isPending}>
            {save.isPending ? "Saving…" : copy.save}
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
    </form>
  );
}
