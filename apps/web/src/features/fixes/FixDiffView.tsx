import type { DiffSnapshot, DiffSource, FixerTurn, PullRequestKey } from "@prkit/contracts";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { DiffList, FileDiffCard } from "~/components/diff";
import { DiffSkeleton } from "~/components/diff/DiffSkeleton";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import { fixerDiffQuery } from "~/rpc/queries";

const Files = ({
  diff,
  source,
  empty,
}: {
  diff: DiffSnapshot;
  source: DiffSource;
  empty: string;
}) =>
  diff.files.length === 0 ? (
    <p role="status" className="text-xs text-muted-foreground">
      {empty}
    </p>
  ) : (
    <DiffList files={diff.files} source={source}>
      <div className="space-y-3">
        {diff.files.map((file) => (
          <FileDiffCard key={file.path} file={file} />
        ))}
      </div>
    </DiffList>
  );

/**
 * The turn's changes: the commit's diff, or for a resolution the conflicted files
 * compared with each side, so the owner sees what each side lost or kept.
 */
export function FixDiffView({ prKey, turn }: { prKey: PullRequestKey; turn: FixerTurn }) {
  const [side, setSide] = useState<"ours" | "theirs">("ours");
  const sha = turn.commit?.sha ?? "";
  const diff = useQuery({ ...fixerDiffQuery(prKey, turn.id, sha), enabled: sha !== "" });
  if (diff.isPending) return <DiffSkeleton lines={8} />;
  if (diff.isError)
    return (
      <div role="alert" className="flex items-center gap-2 text-xs text-error-foreground">
        <span>{diff.error.message}</span>
        <Button size="compact" variant="outline" onClick={() => void diff.refetch()}>
          Retry
        </Button>
      </div>
    );
  const source = { _tag: "fixerTurn", key: prKey, turnId: turn.id, sha } as const;
  if (diff.data._tag === "commit")
    return <Files diff={diff.data.diff} source={source} empty="No file changes." />;
  const sides = [
    { id: "ours", label: `Compared with ${turn.headRef ?? "this branch"}` },
    { id: "theirs", label: `Compared with ${turn.baseRef ?? "the base branch"}` },
  ] as const;
  return (
    <div className="space-y-3">
      <div
        role="group"
        aria-label="Compare the resolution"
        className="flex items-center gap-0.5 rounded-md bg-muted p-0.5 text-xs"
      >
        {sides.map((entry) => (
          <button
            key={entry.id}
            type="button"
            aria-pressed={side === entry.id}
            onClick={() => setSide(entry.id)}
            className={cn(
              "rounded-md px-2.5 py-1 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              side === entry.id
                ? "bg-background text-foreground shadow-xs ring-1 ring-border"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {entry.label}
          </button>
        ))}
      </div>
      <Files
        key={side}
        diff={side === "ours" ? diff.data.ours : diff.data.theirs}
        source={source}
        empty="The conflicted files ended up exactly as on this side."
      />
    </div>
  );
}
