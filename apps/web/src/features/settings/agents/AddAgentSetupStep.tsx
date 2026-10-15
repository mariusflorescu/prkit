import type { UseFormReturn } from "react-hook-form";

import type { AddAgentValues, StepProblem } from "./addAgentWizard";
import { KIND_FIELDS } from "./instanceForm";
import { TextField } from "./TextField";

/** Step 3: which binary runs the instance and which folder holds its login. */
export function AddAgentSetupStep({
  form,
  problem,
}: {
  form: UseFormReturn<AddAgentValues>;
  problem: StepProblem | null;
}) {
  const fields = KIND_FIELDS[form.getValues("kind")];
  return (
    <div className="space-y-4">
      <TextField
        id="add-agent-binary"
        label="Binary path"
        hint={`Empty finds ${fields.binary} on your PATH.`}
        placeholder={fields.binary}
        mono
        error={problem?.field === "binaryPath" ? problem.message : undefined}
        field={form.register("binaryPath")}
      />
      <TextField
        id="add-agent-folder"
        label={fields.folder.label}
        hint={fields.folder.hint}
        placeholder={fields.folder.placeholder}
        mono
        error={problem?.field === "configDir" ? problem.message : undefined}
        field={form.register("configDir")}
      />
    </div>
  );
}
