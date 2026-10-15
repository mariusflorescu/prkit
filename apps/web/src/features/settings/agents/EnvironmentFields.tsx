import { type AgentProviderKind, environmentNameProblem } from "@prkit/contracts";
import { LockIcon, LockOpenIcon, PlusIcon, XIcon } from "lucide-react";
import {
  type Control,
  type UseFormRegister,
  useFieldArray,
  useFormState,
  useWatch,
} from "react-hook-form";

import { Button } from "~/components/ui/button";

import type { InstanceFormValues } from "./instanceForm";

const inputClass =
  "h-8 min-w-0 rounded-md border border-input bg-background px-2.5 font-mono text-base outline-none placeholder:text-placeholder focus-visible:ring-2 focus-visible:ring-ring aria-invalid:border-error sm:text-xs";

const RETYPE = "Type the value again: prkit never shows a saved sensitive value.";

/**
 * The instance's own environment variables. A sensitive value is stored apart from prkit's
 * database and never shown again: its field stays empty, and leaving it empty keeps it.
 * Unlocking a saved one asks for the value again, since prkit can't fill it in.
 */
export function EnvironmentFields({
  kind,
  control,
  register,
  disabled,
}: {
  kind: AgentProviderKind;
  control: Control<InstanceFormValues>;
  register: UseFormRegister<InstanceFormValues>;
  disabled: boolean;
}) {
  const variables = useFieldArray({ control, name: "environment" });
  const values = useWatch({ control, name: "environment" });
  const { errors } = useFormState({ control, name: "environment" });
  return (
    <fieldset className="space-y-2" disabled={disabled}>
      <legend className="text-xs font-medium">Environment variables</legend>
      <p className="text-2xs text-muted-foreground">
        Passed to this agent only. Sensitive values are stored apart and never shown again.
        Variables that change how the agent runs or signs in are refused.
        {kind === "claude" &&
          " Claude Code passes these to commands it runs; on trusted fixes the repository's check scripts can read them."}
        {kind === "cursor" &&
          " Cursor takes one: CURSOR_API_KEY, marked Sensitive, to run on a key from your Cursor dashboard instead of signing in."}
      </p>
      {variables.fields.length > 0 && (
        <ul aria-label="Environment variables" className="space-y-2">
          {variables.fields.map((field, index) => {
            const current = values[index];
            const sensitive = current?.sensitive ?? false;
            const nameError = errors.environment?.[index]?.name?.message;
            const valueError = errors.environment?.[index]?.value?.message;
            // A saved sensitive value, unlocked: prkit can't show it, so it has to be typed again.
            const retype = !sensitive && current?.valueRedacted === true;
            return (
              <li key={field.id} className="space-y-1">
                <div className="flex items-center gap-1.5">
                  <input
                    aria-label={`Variable ${index + 1} name`}
                    placeholder="NAME"
                    autoComplete="off"
                    spellCheck={false}
                    data-1p-ignore
                    aria-invalid={nameError !== undefined}
                    className={`${inputClass} w-44 shrink-0`}
                    {...register(`environment.${index}.name`, {
                      validate: (value, form) =>
                        environmentNameProblem(
                          value.trim(),
                          kind,
                          form.environment[index]?.sensitive ?? false,
                        ) ?? true,
                    })}
                  />
                  <input
                    aria-label={`Variable ${index + 1} value`}
                    type={sensitive ? "password" : "text"}
                    placeholder={
                      sensitive && current?.valueRedacted === true
                        ? "Saved. Type to replace it."
                        : retype
                          ? "Type it again"
                          : "value"
                    }
                    autoComplete="off"
                    spellCheck={false}
                    data-1p-ignore
                    aria-invalid={valueError !== undefined}
                    className={`${inputClass} flex-1`}
                    {...register(`environment.${index}.value`, {
                      validate: (value, form) => {
                        const row = form.environment[index];
                        return row !== undefined &&
                          !row.sensitive &&
                          row.valueRedacted &&
                          value === ""
                          ? RETYPE
                          : true;
                      },
                    })}
                  />
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost-muted"
                    aria-label={sensitive ? "Sensitive: stored apart" : "Mark as sensitive"}
                    aria-pressed={sensitive}
                    title={
                      sensitive ? "Sensitive: stored apart, never shown again" : "Mark as sensitive"
                    }
                    onClick={() =>
                      variables.update(index, {
                        name: current?.name ?? "",
                        value: current?.value ?? "",
                        sensitive: !sensitive,
                        // Kept while unlocked, so locking it again keeps the saved value.
                        valueRedacted: current?.valueRedacted ?? false,
                      })
                    }
                  >
                    {sensitive ? <LockIcon /> : <LockOpenIcon />}
                  </Button>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost-muted"
                    aria-label={`Remove ${current?.name === "" ? "this variable" : current?.name}`}
                    onClick={() => variables.remove(index)}
                  >
                    <XIcon />
                  </Button>
                </div>
                {nameError !== undefined && (
                  <p role="alert" className="text-xs text-error-foreground">
                    {current?.name}: {nameError}
                  </p>
                )}
                {valueError !== undefined ? (
                  <p role="alert" className="text-xs text-error-foreground">
                    {current?.name}: {valueError}
                  </p>
                ) : (
                  retype && (
                    <p className="text-2xs text-muted-foreground">
                      {RETYPE} Lock it again to keep the saved one.
                    </p>
                  )
                )}
              </li>
            );
          })}
        </ul>
      )}
      <Button
        type="button"
        size="xs"
        variant="outline"
        onClick={() =>
          variables.append({ name: "", value: "", sensitive: false, valueRedacted: false })
        }
      >
        <PlusIcon />
        Add variable
      </Button>
    </fieldset>
  );
}
