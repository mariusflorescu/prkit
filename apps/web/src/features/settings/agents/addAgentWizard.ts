import {
  AGENT_KIND_NAMES,
  type AgentInstanceConfig,
  AgentInstanceId,
  type AgentProviderKind,
  deriveInstanceId,
  instanceIdProblem,
} from "@prkit/contracts";

import { pathProblem } from "./instanceForm";

export interface AddAgentValues {
  kind: AgentProviderKind;
  /**
   * Codex: run on a Codex home's login, or a ChatGPT login prkit holds for this agent. Cursor:
   * always a sign-in prkit holds, or the instance's own CURSOR_API_KEY.
   */
  setup: "manual" | "chatgpt" | "cursor";
  label: string;
  /** Null follows the label; a typed id stays. */
  instanceId: string | null;
  accent: string | null;
  binaryPath: string;
  configDir: string;
}

export const defaultsFor = (
  kind: AgentProviderKind,
  setup: AddAgentValues["setup"],
): AddAgentValues => ({
  kind,
  setup,
  label: setup === "chatgpt" ? "Personal" : AGENT_KIND_NAMES[kind].name,
  instanceId: null,
  accent: null,
  binaryPath: "",
  configDir: "",
});

export const STEPS = ["Agent", "Name", "Setup"] as const;
export const CHATGPT_STEPS = ["Agent", "Name", "Sign in"] as const;
export const stepsFor = (setup: AddAgentValues["setup"]) =>
  setup === "manual" ? STEPS : CHATGPT_STEPS;

/** The id the new instance gets: the one typed, else one made from the label that is free. */
export const instanceIdOf = (values: AddAgentValues, existing: ReadonlySet<string>) =>
  values.instanceId ?? deriveInstanceId(values.kind, values.label, existing);

export interface StepProblem {
  readonly field: "label" | "instanceId" | "binaryPath" | "configDir";
  readonly message: string;
}

/** Why Next can't leave `step` yet, on which field, in the dialog's words; null when it can. */
export const stepProblem = (
  step: number,
  values: AddAgentValues,
  existing: ReadonlySet<string>,
): StepProblem | null => {
  if (step === 1) {
    if (values.label.trim() === "") return { field: "label", message: "Give this agent a label." };
    if (values.label.trim().length > 64)
      return { field: "label", message: "Labels are 64 characters or fewer." };
    const id = instanceIdProblem(instanceIdOf(values, existing).trim(), existing);
    return id === null ? null : { field: "instanceId", message: id };
  }
  if (step === 2 && values.setup === "manual") {
    const binary = pathProblem(values.binaryPath);
    if (binary !== true) return { field: "binaryPath", message: binary };
    const folder = pathProblem(values.configDir);
    if (folder !== true) return { field: "configDir", message: folder };
  }
  return null;
};

const blank = (value: string) => (value.trim() === "" ? null : value.trim());

/** The new instance's settings, as the server takes them. */
export const configFromWizard = (
  values: AddAgentValues,
  existing: ReadonlySet<string>,
): AgentInstanceConfig => ({
  id: AgentInstanceId.make(instanceIdOf(values, existing).trim()),
  kind: values.kind,
  label: values.label.trim(),
  accent: values.accent,
  enabled: true,
  configDir: values.setup === "manual" ? blank(values.configDir) : null,
  binaryPath: values.setup === "cursor" ? null : blank(values.binaryPath),
  environment: [],
  login: values.setup === "chatgpt" ? "prkit" : "shared",
});
