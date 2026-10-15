import { Controller, type UseFormReturn, useWatch } from "react-hook-form";

import { AccentField } from "./AccentField";
import { type AddAgentValues, instanceIdOf, type StepProblem } from "./addAgentWizard";
import { TextField } from "./TextField";

const inputClass =
  "h-8 w-full min-w-0 rounded-md border border-input bg-background px-2.5 font-mono text-base outline-none focus-visible:ring-2 focus-visible:ring-ring aria-invalid:border-error sm:text-sm";

/** Step 2: what the instance is called, the id prkit routes by, and its optional marker. */
export function AddAgentNameStep({
  form,
  existing,
  problem,
}: {
  form: UseFormReturn<AddAgentValues>;
  existing: ReadonlySet<string>;
  /** Shown once Next was refused, then kept current as the user types. */
  problem: StepProblem | null;
}) {
  const [kind, setup, label, instanceId] = useWatch({
    control: form.control,
    name: ["kind", "setup", "label", "instanceId"],
  });
  const id = instanceIdOf(
    { kind, setup, label, instanceId, accent: null, binaryPath: "", configDir: "" },
    existing,
  );
  const idProblem = problem?.field === "instanceId" ? problem.message : undefined;
  return (
    <div className="space-y-4">
      <TextField
        id="add-agent-label"
        label={setup === "chatgpt" ? "Account name" : "Label"}
        hint="Shown in the agent list and wherever you pick an agent."
        placeholder="e.g. Work"
        error={problem?.field === "label" ? problem.message : undefined}
        field={form.register("label")}
      />
      <div className="space-y-1">
        <label htmlFor="add-agent-id" className="block text-xs font-medium">
          Instance ID
        </label>
        <Controller
          control={form.control}
          name="instanceId"
          render={({ field }) => (
            <input
              id="add-agent-id"
              type="text"
              autoComplete="off"
              spellCheck={false}
              data-1p-ignore
              value={field.value ?? id}
              aria-invalid={idProblem !== undefined}
              aria-describedby={
                idProblem === undefined
                  ? "add-agent-id-hint"
                  : "add-agent-id-hint add-agent-id-error"
              }
              onChange={(event) => field.onChange(event.target.value)}
              onBlur={field.onBlur}
              className={inputClass}
            />
          )}
        />
        <p id="add-agent-id-hint" className="text-2xs text-muted-foreground">
          Letters, digits, '-', or '_'. It can't change later.
        </p>
        {idProblem !== undefined && (
          <p id="add-agent-id-error" role="alert" className="text-xs text-error-foreground">
            {idProblem}
          </p>
        )}
      </div>
      <Controller
        control={form.control}
        name="accent"
        render={({ field }) => (
          <AccentField id="add-agent-accent" value={field.value} onChange={field.onChange} />
        )}
      />
    </div>
  );
}
