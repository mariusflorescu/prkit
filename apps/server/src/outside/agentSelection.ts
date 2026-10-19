import { type AgentSelection, selectionProblem } from "@prkit/contracts";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import { Agents } from "../agents/Agents.ts";
import { fail } from "./errors.ts";
import type { GenerateGuideInput } from "./schemas.ts";

type SelectionInput = Pick<typeof GenerateGuideInput.Type, "instance" | "model" | "options">;

export const checkedAgent = (
  agents: Context.Service.Shape<typeof Agents>,
  selection: AgentSelection,
) =>
  Effect.gen(function* () {
    const catalog = yield* agents.catalog();
    const problem = selectionProblem(catalog, selection);
    if (problem !== null) return yield* fail("not-ready", problem);
    const descriptors =
      catalog.providers
        .find((entry) => entry.instance === selection.instance)
        ?.models.find((model) => model.slug === selection.model)?.options ?? [];
    const ids = new Set<string>();
    for (const option of selection.options) {
      if (!descriptors.some((entry) => entry.id === option.id) || ids.has(option.id))
        return yield* fail(
          "invalid",
          `Model option ${option.id} is missing or repeated. Use the options from list_agents.`,
        );
      ids.add(option.id);
    }
    return selection;
  });

/** Reject partial selections instead of silently dropping model flags. */
export const requestedAgent = (
  agents: Context.Service.Shape<typeof Agents>,
  input: SelectionInput,
) =>
  Effect.gen(function* () {
    if (input.instance === undefined && input.model === undefined && input.options === undefined)
      return undefined;
    if (input.instance === undefined || input.model === undefined)
      return yield* fail(
        "invalid",
        "Pass instance and model together. list_agents lists the models and options each instance offers.",
      );
    return yield* checkedAgent(agents, {
      instance: input.instance,
      model: input.model,
      options: input.options ?? [],
    });
  });
