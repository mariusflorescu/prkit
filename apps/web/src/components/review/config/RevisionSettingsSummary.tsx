import type { AttemptConfig } from "@prkit/contracts";
import { SlidersHorizontalIcon } from "lucide-react";

import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";

import { RevisionSettingsDetails } from "./RevisionSettingsDetails";
import { revisionSettingsText } from "./revisionSettingsText";

/** "Written with 2 focus areas · skipped 7 files", opening the exact frozen settings. */
export function RevisionSettingsSummary({ config }: { config: AttemptConfig }) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          // A plain trigger, unlike Button, can shrink and truncate next to the revision controls.
          <button
            type="button"
            className="flex h-7 min-w-0 cursor-pointer items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-accent"
          />
        }
      >
        <SlidersHorizontalIcon aria-hidden="true" className="size-3.5 shrink-0" />
        <span data-revision-settings="" className="truncate">
          {revisionSettingsText(config)}
        </span>
      </PopoverTrigger>
      <PopoverPopup width="xl" align="start" padding="none">
        <RevisionSettingsDetails config={config} />
      </PopoverPopup>
    </Popover>
  );
}
