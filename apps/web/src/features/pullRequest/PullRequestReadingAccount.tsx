import type { PullRequestDetail } from "@prkit/contracts";
import { useQuery } from "@tanstack/react-query";

import { UserAvatar } from "~/components/UserAvatar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { accountsQuery } from "~/rpc/queries";

/**
 * The GitHub account this PR is read through: its avatar, with the account in a tooltip
 * that keyboard focus opens too.
 */
export function PullRequestReadingAccount({ detail }: { detail: PullRequestDetail }) {
  const accounts = useQuery(accountsQuery);
  const account = accounts.data?.accounts.find((entry) => entry.id === detail.accountId);
  const login = account?.login ?? detail.accountId.slice(detail.accountId.indexOf("/") + 1);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className="inline-flex shrink-0 items-center rounded-full opacity-80 outline-none hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring"
          />
        }
      >
        <UserAvatar login={login} url={account?.avatarUrl ?? null} />
        <span className="sr-only">
          Read through <span data-reading-account="">{detail.accountId}</span>
        </span>
      </TooltipTrigger>
      <TooltipPopup>Read through {detail.accountId}</TooltipPopup>
    </Tooltip>
  );
}
