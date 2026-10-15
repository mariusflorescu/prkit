import {
  type AgentSelection,
  effectiveSelection,
  findAgentEntry,
  FixerError,
  selectionProblem,
} from "@prkit/contracts";
import * as Effect from "effect/Effect";

import { Agents } from "../agents/Agents.ts";
import { GuideSettingsStore } from "../reviews/GuideSettingsStore.ts";
import type { FixerRow } from "./fixerRows.ts";

/** Which agent a fix session's next turn runs on. */
export const makeAgentChoice = Effect.gen(function* () {
  const agents = yield* Agents;
  const guideSettings = yield* GuideSettingsStore;

  /**
   * The agent for a new turn: the one asked for (checked against the catalog), else the
   * session's own, else its kind's default while the session's is off or gone, else the
   * default from Settings > Agents.
   */
  const chooseAgent = (requested: AgentSelection | undefined, fixer: FixerRow | null) =>
    Effect.gen(function* () {
      const own =
        requested === undefined && fixer !== null
          ? yield* agents.usable(fixer.instance_id, fixer.provider)
          : null;
      if (requested === undefined && fixer !== null && own !== null)
        return {
          instance: own,
          provider: fixer.provider,
          model: fixer.model,
          options: fixer.model_options,
        };
      const catalog = yield* agents.catalog();
      if (requested !== undefined) {
        const problem = selectionProblem(catalog, requested);
        const entry = findAgentEntry(catalog, requested.instance);
        if (problem !== null || entry === undefined)
          return yield* new FixerError({ message: problem ?? "Pick an agent." });
        return { ...requested, provider: entry.kind };
      }
      const stored = yield* guideSettings
        .get()
        .pipe(
          Effect.catchTag("GuideSettingsError", (error) =>
            Effect.fail(new FixerError({ message: error.message })),
          ),
        );
      const chosen = effectiveSelection(catalog, stored.defaultAgent);
      const entry = chosen === null ? undefined : findAgentEntry(catalog, chosen.instance);
      if (chosen === null || entry === undefined)
        return yield* new FixerError({
          message: "No agent is ready. Sign one in under Settings > Agents, then check again.",
        });
      return { ...chosen, provider: entry.kind };
    });

  /**
   * For a turn queued without anyone picking an agent, which may run none (a revert): the agent
   * `chooseAgent` falls back to, else the session's own, so no agent being ready never blocks it.
   */
  const chooseAgentOrKeep = (fixer: FixerRow) =>
    chooseAgent(undefined, fixer).pipe(
      Effect.catchTag("FixerError", () =>
        Effect.succeed({
          instance: fixer.instance_id,
          provider: fixer.provider,
          model: fixer.model,
          options: fixer.model_options,
        }),
      ),
    );

  return { chooseAgent, chooseAgentOrKeep };
});
