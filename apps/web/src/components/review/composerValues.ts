import type { AgentSelection, GuidanceMode, PullRequestStack } from "@prkit/contracts";

/** Which layers of the PR's stack get a guide. */
export type GuideScopeChoice = "this" | "stack" | "layers";

export interface ComposerValues {
  /** This PR's guidance block, saved when the guide starts. */
  guidance: string;
  guidanceMode: GuidanceMode;
  /** Null until the user picks: the review's own agent, else the default from Settings. */
  agent: AgentSelection | null;
  scope: GuideScopeChoice;
  /** PR numbers ticked under Choose layers. */
  layers: ReadonlyArray<number>;
  /** Write guides again for chosen layers that already have one. */
  regenerate: boolean;
}

/** The layers a scope chooses, bottom to top; closed and merged layers never get a guide. */
export const chosenLayers = (
  stack: PullRequestStack | null,
  scope: GuideScopeChoice,
  ticked: ReadonlyArray<number>,
) => {
  if (stack === null || scope === "this") return [];
  return stack.layers.filter(
    (layer) => layer.state === "open" && (scope === "stack" || ticked.includes(layer.number)),
  );
};
