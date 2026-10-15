import { environmentNameProblem } from "@prkit/contracts";
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

/**
 * The instance's own environment variables. A sensitive value is stored apart from prkit's
 * database and never shown again: its field stays empty, and leaving it empty keeps it.
 */
export function EnvironmentFields({
  control,
  register,
  disabled,
}: {
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
      </p>
      {variables.fields.length > 0 && (
        <ul aria-label="Environment variables" className="space-y-2">
          {variables.fields.map((field, index) => {
            const current = values[index];
            const sensitive = current?.sensitive ?? false;
            const nameError = errors.environment?.[index]?.name?.message;
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
                      validate: (value) => environmentNameProblem(value.trim()) ?? true,
                    })}
                  />
                  <input
                    aria-label={`Variable ${index + 1} value`}
                    type={sensitive ? "password" : "text"}
                    placeholder={
                      sensitive && current?.valueRedacted === true
                        ? "Saved. Type to replace it."
                        : "value"
                    }
                    autoComplete="off"
                    spellCheck={false}
                    data-1p-ignore
                    className={`${inputClass} flex-1`}
                    {...register(`environment.${index}.value`)}
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
                        valueRedacted: !sensitive ? false : (current?.valueRedacted ?? false),
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
