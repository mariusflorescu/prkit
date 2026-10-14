import { pullRequestMenuActions, type PullRequestDetail } from "@prkit/contracts";
import { MoreHorizontalIcon } from "lucide-react";
import { Fragment, useRef } from "react";

import { Button } from "~/components/ui/button";
import { Menu, MenuGroup, MenuPopup, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import { useStartPullRequestAction } from "./actionContext";
import { PullRequestMenuItem } from "./PullRequestMenuItem";

/**
 * The header's ⋯: the PR's other state changes, merge actions first. Nothing that has a
 * place on the page (GitHub link, checkout, editing, reviewers, labels), and no menu
 * at all when nothing applies.
 */
export function PullRequestActionsMenu({ detail }: { detail: PullRequestDetail }) {
  const start = useStartPullRequestAction();
  const anchor = useRef<HTMLButtonElement>(null);
  const groups = pullRequestMenuActions(detail);
  if (groups.length === 0) return null;
  return (
    <Menu>
      <MenuTrigger
        ref={anchor}
        render={<Button size="icon-xs" variant="ghost-muted" />}
        aria-label="More pull request actions"
      >
        <MoreHorizontalIcon />
      </MenuTrigger>
      <MenuPopup align="end" sideOffset={6}>
        {groups.map((group, index) => (
          <Fragment key={group.join()}>
            {index > 0 && <MenuSeparator />}
            <MenuGroup>
              {group.map((kind) => (
                <PullRequestMenuItem
                  key={kind}
                  detail={detail}
                  kind={kind}
                  onStart={(chosen) => {
                    if (anchor.current) start(chosen, anchor.current);
                  }}
                />
              ))}
            </MenuGroup>
          </Fragment>
        ))}
      </MenuPopup>
    </Menu>
  );
}
