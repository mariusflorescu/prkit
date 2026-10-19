import type { DesktopUpdateState, UpdateChannel } from "@prkit/contracts";
import { useId } from "react";

import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { FailedSave } from "~/features/settings/FailedSave";

import { updateErrorMessage, useSetUpdateChannel } from "./updateQueries";

const TRACKS: ReadonlyArray<{ value: UpdateChannel; label: string }> = [
  { value: "stable", label: "Stable" },
  { value: "nightly", label: "Nightly" },
];

/** Stable or Nightly, applied at once: switching checks the new track right away. */
export function UpdateTrackSelect({ state }: { state: DesktopUpdateState }) {
  const setChannel = useSetUpdateChannel();
  const labelId = useId();
  const busy =
    setChannel.isPending || state.status === "checking" || state.status === "downloading";
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-4">
        <span id={labelId} className="text-sm text-foreground">
          Track
        </span>
        <Select<UpdateChannel>
          value={setChannel.isPending ? (setChannel.variables ?? state.channel) : state.channel}
          items={TRACKS}
          disabled={busy}
          onValueChange={(next) => {
            if (next !== null && next !== state.channel) setChannel.mutate(next);
          }}
        >
          <SelectTrigger aria-labelledby={labelId} size="sm" className="w-36 shrink-0">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            {TRACKS.map((track) => (
              <SelectItem key={track.value} value={track.value}>
                {track.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
      <p className="text-xs text-muted-foreground">
        Nightly gets each change within a few hours, before it ships to Stable, and may have rough
        edges.
      </p>
      <FailedSave save={setChannel} describe={updateErrorMessage} />
    </div>
  );
}
