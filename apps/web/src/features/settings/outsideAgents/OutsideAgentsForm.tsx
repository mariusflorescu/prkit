import type { OutsideAccess, OutsideAgentsSettings, OutsideAgentsState } from "@prkit/contracts";
import { useId } from "react";
import { Controller, useForm } from "react-hook-form";

import { Switch } from "~/components/ui/switch";

const LEVELS: ReadonlyArray<{ value: OutsideAccess; label: string; detail: string }> = [
  {
    value: "read",
    label: "Read only",
    detail: "Your inbox, open PRs, guides, review comments and fixes.",
  },
  {
    value: "work",
    label: "Read and start work",
    detail:
      "Also open PRs here, start guides, add draft comments and send them to the fix agent. Pushing, merging and posting to GitHub stay a click in prkit.",
  },
];

/** The switch and the level. Each change saves at once, like every other setting. */
export function OutsideAgentsForm({
  settings,
  saving,
  onSave,
}: {
  settings: OutsideAgentsSettings;
  saving: boolean;
  onSave: (settings: OutsideAgentsSettings) => Promise<OutsideAgentsState>;
}) {
  // `values` moves the form to what the server says after each read and save.
  const form = useForm<OutsideAgentsSettings>({ values: settings });
  const detailId = useId();
  // A failed save leaves the server and `values` as they were, so only this takes the form back.
  const save = form.handleSubmit((values) => onSave(values).catch(() => form.reset()));
  return (
    <form
      noValidate
      aria-label="Outside agents"
      onSubmit={(event) => void save(event)}
      className="mt-4"
    >
      <div className="flex min-h-14 items-center justify-between gap-4 border-b border-border/60 py-3">
        <div className="min-w-0">
          <p className="text-sm">Let my coding agents use prkit</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Only from this machine, through the command below. Off by default.
          </p>
        </div>
        <Controller
          control={form.control}
          name="enabled"
          render={({ field }) => (
            <Switch
              checked={field.value}
              disabled={saving}
              aria-label="Let my coding agents use prkit"
              onCheckedChange={(checked) => {
                field.onChange(checked);
                void save();
              }}
            />
          )}
        />
      </div>
      <fieldset className="space-y-2 py-3" disabled={saving}>
        <legend className="text-sm">What they can do</legend>
        {LEVELS.map((level) => (
          <div key={level.value} className="has-disabled:opacity-60">
            <label className="flex cursor-pointer items-center gap-2 text-sm has-disabled:cursor-not-allowed">
              <input
                type="radio"
                value={level.value}
                aria-describedby={`${detailId}-${level.value}`}
                {...form.register("access", { onChange: () => void save() })}
              />
              {level.label}
            </label>
            <p id={`${detailId}-${level.value}`} className="ml-5 text-xs text-muted-foreground">
              {level.detail}
            </p>
          </div>
        ))}
      </fieldset>
    </form>
  );
}
