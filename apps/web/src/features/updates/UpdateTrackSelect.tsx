import type { DesktopUpdateState, UpdateChannel } from "@prkit/contracts";
import { useId } from "react";

import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { SettingsAlert } from "~/features/settings/SettingsAlert";

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
          value={state.channel}
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
        Nightly gets each day's build first, before it ships to Stable, and may have rough edges.
      </p>
      {setChannel.error !== null && (
        <SettingsAlert
          message={updateErrorMessage(setChannel.error)}
          retry={() => {
            const last = setChannel.variables;
            setChannel.reset();
            if (last !== undefined) setChannel.mutate(last);
          }}
        />
      )}
    </div>
  );
}
