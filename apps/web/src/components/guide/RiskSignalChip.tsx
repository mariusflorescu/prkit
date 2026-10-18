import {
  describeSignal,
  type GuideScopeName,
  type RiskSignal,
  SCOPE_LABELS,
  signalFiles,
} from "@prkit/contracts";
import { useRef, useState } from "react";

import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";

const plural = (count: number, noun: string) =>
  `${count.toLocaleString("en-US")} ${noun}${count === 1 ? "" : "s"}`;

/** One of prkit's facts about the diff, opening the files it names. */
export function RiskSignalChip({
  signal,
  written,
  onFile,
}: {
  signal: RiskSignal;
  /** Files in a chapter the agent has written: the others can't open yet. */
  written: ReadonlySet<string>;
  onFile: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  // Opening a file moves focus to its card, so closing must not hand focus back to the chip.
  const openedFile = useRef(false);
  const { label, text } = describeSignal(signal);
  if (signal._tag === "large")
    return (
      <span data-risk-signal="" title={text}>
        {label}: {plural(signal.lines, "line")}
      </span>
    );
  const patternOf = (file: { readonly pattern: string; readonly scope: GuideScopeName }) =>
    `${file.pattern} (${SCOPE_LABELS[file.scope]})`;
  const groups: ReadonlyArray<{ pattern: string | null; paths: ReadonlyArray<string> }> =
    signal._tag === "sensitive"
      ? [...new Set(signal.files.map(patternOf))].map((pattern) => ({
          pattern,
          paths: signal.files
            .filter((file) => patternOf(file) === pattern)
            .map((file) => file.path),
        }))
      : [{ pattern: null, paths: signalFiles(signal) }];
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        openedFile.current = false;
        setOpen(next);
      }}
    >
      <PopoverTrigger render={<button type="button" data-risk-signal="" />}>
        {label}: {plural(signalFiles(signal).length, "file")}
      </PopoverTrigger>
      <PopoverPopup
        width="lg"
        align="start"
        padding="compact"
        finalFocus={() => !openedFile.current}
        aria-label={label}
      >
        <div data-risk-signal-popup="">
          <p>{text}</p>
          {groups.map(({ pattern, paths }) => (
            <div key={pattern ?? ""}>
              {pattern !== null && <small>{pattern}</small>}
              <ul>
                {paths.map((path) => (
                  <li key={path}>
                    {written.has(path) ? (
                      <button
                        type="button"
                        aria-label={`Open ${path}`}
                        onClick={() => {
                          openedFile.current = true;
                          setOpen(false);
                          onFile(path);
                        }}
                      >
                        {path}
                      </button>
                    ) : (
                      <button type="button" disabled title="Not in a chapter yet">
                        {path}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
