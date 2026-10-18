import { Link } from "@tanstack/react-router";
import { FolderGit2Icon } from "lucide-react";

import { Button } from "~/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty";

/** A local review that was removed, or a link that names none. */
export function LocalReviewGone() {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <FolderGit2Icon />
        </EmptyMedia>
        <EmptyTitle role="heading" aria-level={1}>
          This local review was removed
        </EmptyTitle>
        <EmptyDescription>
          Its guides went with it, and your repository was never touched. Run{" "}
          <span className="font-mono">prkit local guide</span> in its folder to start a new one.
        </EmptyDescription>
      </EmptyHeader>
      <Button variant="outline" render={<Link to="/" />}>
        Go to Inbox
      </Button>
    </Empty>
  );
}
