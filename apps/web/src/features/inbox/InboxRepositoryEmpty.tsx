import type { RepositoryFilter } from "@prkit/contracts";
import { FolderGit2Icon } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty";

import { RepositoryPullRequestList } from "./RepositoryPullRequestList";

/** The Inbox filtered to a repository where nothing needs you: offers its open pull requests. */
export function InboxRepositoryEmpty({
  repository,
  clear,
}: {
  repository: RepositoryFilter;
  clear: () => void;
}) {
  const [showOpen, setShowOpen] = useState(false);
  const name = `${repository.owner}/${repository.name}`;
  if (showOpen) return <RepositoryPullRequestList repository={repository} />;
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <FolderGit2Icon />
        </EmptyMedia>
        <EmptyTitle role="heading" aria-level={2}>
          Nothing in {name} needs you
        </EmptyTitle>
        <EmptyDescription>
          No open pull request there asks for your review, is yours, or involves you.
        </EmptyDescription>
      </EmptyHeader>
      <div className="flex flex-wrap justify-center gap-2">
        <Button variant="outline" onClick={() => setShowOpen(true)}>
          Show open pull requests in {name}
        </Button>
        <Button variant="ghost-muted" onClick={clear}>
          Clear filters
        </Button>
      </div>
    </Empty>
  );
}
