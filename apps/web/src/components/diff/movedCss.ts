import type { DiffFile } from "@prkit/contracts";

import { fileRows } from "./fileDiff";
import { chipLine, type FileMoves } from "./moves";

const types = { old: "change-deletion", new: "change-addition" } as const;

const css = new WeakMap<FileMoves, string>();

/**
 * Quiets the moved lines of one file: a soft info tint instead of red or green. Keyed by
 * line type and number, so in one column a deletion and an addition with the same number
 * never take each other's look. A chip's row stays plain even under a changed line, since
 * it heads the block below rather than adding to the line above.
 */
export function movedCss(file: DiffFile, moves: FileMoves) {
  const known = css.get(moves);
  if (known !== undefined) return known;
  const rows = fileRows(file);
  const rules = (["old", "new"] as const).flatMap((side) => {
    const type = types[side];
    const lines = [...moves.quiet[side]];
    const ends =
      side === "old" ? moves.cut.map((move) => move.from) : moves.landed.map((move) => move.to);
    const chips = ends.map((end) => chipLine(rows, end)).filter((line) => line > 0);
    const any = (attribute: string) =>
      `:is(${lines.map((line) => `[${attribute}='${line}']`).join(",")})`;
    const quiet =
      lines.length === 0
        ? []
        : [
            `[data-line][data-line-type='${type}']${any("data-line")} {
  --diffs-computed-diff-line-bg: color-mix(in srgb, var(--code-background) 90%, var(--info));
}`,
            `[data-column-number][data-line-type='${type}']${any("data-column-number")} {
  --diffs-computed-diff-line-bg: color-mix(in srgb, var(--code-background) 84%, var(--info));
  color: var(--info-foreground);
}`,
            `[data-indicators='bars'] [data-column-number][data-line-type='${type}']${any("data-column-number")}::before {
  background: var(--info);
}`,
          ];
    const plain = chips.map(
      (
        line,
      ) => `[data-line][data-line-type='${type}'][data-line='${line}'] + [data-line-annotation],
[data-column-number][data-line-type='${type}'][data-column-number='${line}'] + [data-gutter-buffer='annotation'] {
  --diffs-computed-diff-line-bg: var(--diffs-bg);
}`,
    );
    return quiet.concat(plain);
  });
  const sheet = rules.join("\n");
  css.set(moves, sheet);
  return sheet;
}
