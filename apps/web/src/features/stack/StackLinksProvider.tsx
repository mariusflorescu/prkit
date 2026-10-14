import type { PullRequestDetail } from "@prkit/contracts";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { StackLinksContext } from "~/components/diff/stackLinks";
import { useWorkspaceSession } from "~/features/workspace/sessionStore";
import { useWorkspace } from "~/features/workspace/workspaceContext";
import { pullRequestStackQuery } from "~/rpc/queries";

import { layerKey } from "./stackPresentation";

/** Lets the guide's `#123` for a layer of this PR's stack open that layer's Guide tab. */
export function StackLinksProvider({
  detail,
  children,
}: {
  detail: PullRequestDetail;
  children: ReactNode;
}) {
  const workspace = useWorkspace();
  const stack = useQuery({
    ...pullRequestStackQuery(detail.key, detail.accountId),
    enabled: detail.stack !== null,
  }).data;
  const repositoryUrl = detail.url.slice(0, detail.url.lastIndexOf("/pull/"));
  const value =
    stack == null
      ? null
      : {
          repositoryUrl,
          layers: new Set(stack.layers.map((layer) => layer.number)),
          open: (number: number) => {
            const key = layerKey(detail.ref, { number });
            useWorkspaceSession.getState().rememberTab(key, "guide");
            workspace.open(key, detail.accountId);
          },
        };
  return <StackLinksContext value={value}>{children}</StackLinksContext>;
}
