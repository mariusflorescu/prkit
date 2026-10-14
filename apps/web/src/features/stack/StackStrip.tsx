import type { PullRequestDetail } from "@prkit/contracts";
import { useQuery } from "@tanstack/react-query";
import { ChevronRightIcon, LayersIcon } from "lucide-react";
import { Fragment } from "react";

import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { useWorkspace } from "~/features/workspace/workspaceContext";
import { pullRequestStackQuery, reviewFeedQuery } from "~/rpc/queries";

import { StackLayerButton } from "./StackLayerButton";
import { layerGuide, layerKey } from "./stackPresentation";

/**
 * The stack this PR is a layer of, bottom to top, under the PR header. A layer opens
 * as a tab. Only stacked PRs have it, and its height is held while it loads.
 */
export function StackStrip({ detail }: { detail: PullRequestDetail }) {
  const workspace = useWorkspace();
  const stack = useQuery({
    ...pullRequestStackQuery(detail.key, detail.accountId),
    enabled: detail.stack !== null,
  });
  const reviews = useQuery(reviewFeedQuery).data;
  if (detail.stack === null) return null;
  const frame = "flex h-10 min-w-0 items-center gap-1 overflow-x-auto px-4";
  if (stack.isPending)
    return (
      <div aria-busy="true" aria-label="Loading stack" className={frame}>
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-5 w-40" />
      </div>
    );
  if (stack.isError)
    return (
      <div role="alert" className={`${frame} text-xs text-error-foreground`}>
        <span className="min-w-0 truncate">Couldn't load this stack: {stack.error.message}</span>
        <Button variant="outline" size="micro" onClick={() => void stack.refetch()}>
          Retry
        </Button>
      </div>
    );
  if (stack.data === null) return null;
  const { layers, base } = stack.data;
  return (
    <nav aria-label="Stack" data-stack-strip={stack.data.number} className={frame}>
      <span className="mr-1 flex shrink-0 items-center gap-1.5 text-2xs text-muted-foreground">
        <LayersIcon aria-hidden className="size-3.5" />
        Stack on <span className="font-mono">{base}</span>
      </span>
      {layers.map((layer, index) => {
        const key = layerKey(detail.ref, layer);
        return (
          <Fragment key={layer.number}>
            {index > 0 && (
              <ChevronRightIcon aria-hidden className="size-3 shrink-0 text-muted-foreground/50" />
            )}
            <StackLayerButton
              layer={layer}
              size={layers.length}
              current={layer.number === detail.ref.number}
              guide={layerGuide(reviews?.get(key))}
              onOpen={() => workspace.open(key, detail.accountId)}
            />
          </Fragment>
        );
      })}
    </nav>
  );
}
