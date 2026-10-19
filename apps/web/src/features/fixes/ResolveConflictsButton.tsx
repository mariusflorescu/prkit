import { FIXER_BUSY, type PullRequestDetail } from "@prkit/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { GitMergeIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { ButtonLabel } from "~/components/ui/button-label";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { fixerQuery } from "~/rpc/queries";

import { ResolveConflictsForm } from "./ResolveConflictsForm";
import { useFixerWatch } from "./useFixerWatch";

const LABELS = {
  resolve: "Resolve conflicts",
  resolving: "Resolving conflicts…",
  review: "Review the resolution",
};

/** The header's primary action on a conflicting PR: the agent resolves, or it shows that it is. */
export function ResolveConflictsButton({ detail }: { detail: PullRequestDetail }) {
  useFixerWatch(detail.key);
  const fixer = useQuery(fixerQuery(detail.key));
  const [open, setOpen] = useState(false);
  const active = fixer.data?.turns.find(
    (turn) =>
      turn.work._tag === "conflicts" &&
      (turn.status._tag === "queued" || FIXER_BUSY.includes(turn.status._tag)),
  );
  if (active !== undefined)
    return (
      <Button
        size="xs"
        variant="outline"
        render={
          <Link
            to="/pr/$host/$owner/$repo/$number"
            params={{
              host: detail.ref.host,
              owner: detail.ref.owner,
              repo: detail.ref.repo,
              number: String(detail.ref.number),
            }}
            search={{ account: detail.accountId, tab: "fixes" }}
          />
        }
      >
        <ButtonLabel
          icon={<GitMergeIcon />}
          shown={active.status._tag === "ready" ? "review" : "resolving"}
          labels={LABELS}
        />
      </Button>
    );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button size="xs" variant="outline" />}>
        <ButtonLabel icon={<GitMergeIcon />} shown="resolve" labels={LABELS} />
      </PopoverTrigger>
      <PopoverPopup width="xl" align="end">
        <p className="mb-3 text-sm font-medium">Resolve conflicts with the agent</p>
        {open && <ResolveConflictsForm detail={detail} onDone={() => setOpen(false)} />}
      </PopoverPopup>
    </Popover>
  );
}
