import {
  type AgentCatalog,
  type AgentSelection,
  explicitModelOptions,
  findAgentModel,
  type PullRequestDetail,
} from "@prkit/contracts";
import { useQuery } from "@tanstack/react-query";

import { typicalDurationQuery } from "~/rpc/queries";

import { formatTypical } from "./reviewFormat";

/**
 * "Usually about 4 min for PRs this size", only when prkit has two or more past guides at the
 * same model and settings on a diff of similar size.
 */
export function TypicalDuration({
  detail,
  selection,
  catalog,
}: {
  detail: PullRequestDetail;
  selection: AgentSelection | null;
  catalog: AgentCatalog | undefined;
}) {
  const model =
    selection === null || catalog === undefined
      ? undefined
      : findAgentModel(catalog, selection.instance, selection.model);
  const typical = useQuery(
    typicalDurationQuery(
      selection === null || model === undefined
        ? null
        : { ...selection, options: explicitModelOptions(model, selection.options) },
      detail.additions + detail.deletions,
    ),
  );
  if (typical.data == null) return null;
  return (
    <p data-typical-duration="" className="text-xs text-muted-foreground">
      Usually {formatTypical(typical.data.seconds)} for PRs this size
    </p>
  );
}
