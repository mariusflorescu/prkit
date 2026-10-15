import type { AgentModel, ModelOptionChoice, ModelOptionDescriptor } from "@prkit/contracts";

import type { RunnerModel } from "./protocol.ts";

/**
 * A model Cursor lists, as a catalog model: each of its parameters (reasoning effort, thinking,
 * context size...) a setting, defaulting to the value of its default variant.
 */
export const toModel = (model: RunnerModel, isDefault: boolean): AgentModel => {
  const defaults = model.variants?.find((variant) => variant.isDefault === true)?.params ?? [];
  const options: Array<ModelOptionDescriptor> = [];
  for (const parameter of model.parameters ?? []) {
    const fallback = defaults.find((param) => param.id === parameter.id)?.value;
    const [first, ...rest] = parameter.values.map((entry): ModelOptionChoice => ({
      id: entry.value,
      label: entry.displayName ?? entry.value,
      ...(entry.value === fallback ? { isDefault: true } : {}),
    }));
    if (first === undefined || parameter.id === "") continue;
    options.push({
      id: parameter.id,
      label: parameter.displayName ?? parameter.id,
      type: "select",
      options: [first, ...rest],
    });
  }
  return {
    slug: model.id,
    name: model.displayName,
    description: model.description ?? null,
    isDefault,
    options,
    blocked: null,
  };
};

/** Cursor's own pick ("Auto") is the default when it lists one; else its first model. */
export const toModels = (models: ReadonlyArray<RunnerModel>): ReadonlyArray<AgentModel> => {
  const list = models.filter((model) => model.id !== "");
  const chosen = (list.find((model) => model.id === "auto" || model.id === "default") ?? list[0])
    ?.id;
  return list.map((model) => toModel(model, model.id === chosen));
};
