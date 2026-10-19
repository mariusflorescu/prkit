import type { AgentCatalogEntry } from "@prkit/contracts";
import { Controller, useForm } from "react-hook-form";

import { Button } from "~/components/ui/button";

import { SettingsAlert } from "../SettingsAlert";
import { AccentField } from "./AccentField";
import { EnvironmentFields } from "./EnvironmentFields";
import { configOf } from "./instanceConfig";
import {
  configFrom,
  formValuesOf,
  type InstanceFormValues,
  KIND_FIELDS,
  pathProblem,
} from "./instanceForm";
import { TextField } from "./TextField";
import { useAgentInstanceActions } from "./useAgentInstanceActions";

/** Edits one instance in place: its name, marker, binary, folder and environment. */
export function AgentInstanceEditor({
  entry,
  onDone,
}: {
  entry: AgentCatalogEntry;
  onDone: () => void;
}) {
  const { update } = useAgentInstanceActions();
  const form = useForm<InstanceFormValues>({ defaultValues: formValuesOf(entry) });
  const { errors, isDirty } = form.formState;
  // Cursor runs through its SDK in a folder of prkit's own: no binary, no config folder.
  const fields = entry.kind === "cursor" ? null : KIND_FIELDS[entry.kind];
  const id = (name: string) => `agent-${entry.instance}-${name}`;
  const submit = form.handleSubmit((values) =>
    update.mutate(configFrom(configOf(entry), values), { onSuccess: onDone }),
  );
  return (
    <form
      noValidate
      aria-label={`Edit ${entry.label}`}
      onSubmit={(event) => void submit(event)}
      className="mt-3 space-y-4 rounded-lg border border-border/60 p-4"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          id={id("label")}
          label="Label"
          hint="Shown in the agent list and wherever you pick an agent."
          error={errors.label?.message}
          disabled={update.isPending}
          field={form.register("label", {
            validate: (value) =>
              (value.trim() !== "" && value.trim().length <= 64) ||
              "Give it a name of up to 64 characters.",
          })}
        />
        <Controller
          control={form.control}
          name="accent"
          render={({ field }) => (
            <AccentField
              id={id("accent")}
              value={field.value}
              onChange={field.onChange}
              disabled={update.isPending}
            />
          )}
        />
        {fields !== null && (
          <TextField
            id={id("binary")}
            label="Binary path"
            hint={`Empty finds ${fields.binary} on your PATH.`}
            placeholder={fields.binary}
            mono
            error={errors.binaryPath?.message}
            disabled={update.isPending}
            field={form.register("binaryPath", { validate: pathProblem })}
          />
        )}
        {fields !== null && entry.login === "shared" && (
          <TextField
            id={id("folder")}
            label={fields.folder.label}
            hint={fields.folder.hint}
            placeholder={fields.folder.placeholder}
            mono
            error={errors.configDir?.message}
            disabled={update.isPending}
            field={form.register("configDir", { validate: pathProblem })}
          />
        )}
      </div>
      <EnvironmentFields
        kind={entry.kind}
        control={form.control}
        register={form.register}
        disabled={update.isPending}
      />
      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost-muted"
          onClick={onDone}
          disabled={update.isPending}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          size="sm"
          disabled={update.isPending || !isDirty}
          aria-busy={update.isPending}
        >
          {update.isPending ? "Saving…" : "Save"}
        </Button>
      </div>
      {update.error !== null && (
        <SettingsAlert message={update.error.message} retry={() => void submit()} />
      )}
    </form>
  );
}
