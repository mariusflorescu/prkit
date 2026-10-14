import { Columns2, Rows2, WrapText } from "lucide-react";

import { ToolbarIconButton } from "~/components/ToolbarIconButton";

import { useDiffPrefs } from "./diffPrefs";

export function DiffControls() {
  const { diffStyle, wrap, setDiffStyle, toggleWrap } = useDiffPrefs();
  return (
    <div role="group" className="flex items-center gap-0.5" aria-label="Diff preferences">
      <ToolbarIconButton
        label="Unified"
        pressed={diffStyle === "unified"}
        onClick={() => setDiffStyle("unified")}
      >
        <Rows2 />
      </ToolbarIconButton>
      <ToolbarIconButton
        label="Split"
        pressed={diffStyle === "split"}
        onClick={() => setDiffStyle("split")}
      >
        <Columns2 />
      </ToolbarIconButton>
      <ToolbarIconButton label="Wrap" pressed={wrap} onClick={toggleWrap}>
        <WrapText />
      </ToolbarIconButton>
    </div>
  );
}
