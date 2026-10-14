import type { DoneReason } from "@prkit/contracts";
import { BookOpenTextIcon } from "lucide-react";

import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty";

/** A merged or closed PR that never got a guide. */
export function GuideEnded({ reason }: { reason: Exclude<DoneReason, "stopped"> }) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <BookOpenTextIcon />
        </EmptyMedia>
        <EmptyTitle role="heading" aria-level={2}>
          This pull request was {reason}
        </EmptyTitle>
        <EmptyDescription>
          prkit writes guides for open pull requests. If it is reopened, you can generate one here.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
