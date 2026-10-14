/**
 * The stack figure's card, built at build time: three pull requests stacked bottom to top, each with its own
 * guide beside it, joined only to its own diff, and your agent writing them bottom to top.
 */
import * as k from "../kit/iso-kit.mjs";
import { DIGITAL_CSS } from "../kit/prkit-digital.mjs";
import { legend } from "../kit/prkit-frame.ts";
import { H, W, drawing } from "./geometry.mjs";
import { LAYERS, T_STILL, stateAt } from "./model.mjs";

// The cursor types on the guide's face, so the prompt chevron the kit draws before it would sit on the words it
// has just typed: it is hidden here.
const STYLE = `<style>${DIGITAL_CSS}
[data-figure="stack-guides"] [data-lift]{transition:opacity .45s cubic-bezier(.23,1,.32,1)}
[data-figure="stack-guides"] [data-part^="cursor-"]>g:not(.dg-gem){display:none}
@media (prefers-reduced-motion:reduce){[data-figure="stack-guides"] [data-lift]{transition:none}}
</style>`;

export function figure() {
  const still = stateAt(T_STILL);
  const svg = k.figureSvg({
    width: W,
    height: H,
    label: `A stack of ${LAYERS.length} pull requests drawn as app windows, numbered 1 to ${LAYERS.length} from the bottom. Each window shows its place in the stack, its base branch pointing at the head of the layer below, the stack strip with every layer's guide state, and only its own diff. Beside each window stands its own guide, joined by one connector to that layer's diff. Layers 1 and 2 have their guides; your agent, a rose terminal cursor, is writing layer 3's guide row by row.`,
    body: [STYLE, drawing(still.guides)],
  });
  return {
    svg,
    title: "One guide per layer",
    hint: "Pick a layer",
    caption: `A stack's layers, numbered from the bottom, each based on the one below. Whole stack writes a guide for each open layer without one, bottom to top, two at a time. Each guide explains only its own layer's diff and names the others by number.`,
    legend: legend([
      { mark: "lit", label: "Rose: your agent, and the guide it is writing" },
      { mark: "dim", label: "Dashed: a layer's base, the head of the layer below" },
    ]),
    controls: [
      ...LAYERS.map(
        (_, layer) =>
          `<button type="button" data-layer-button="${layer}" aria-pressed="false" aria-label="Layer ${layer + 1}: show its pull request and guide">Layer ${layer + 1}</button>`,
      ),
      `<button type="button" data-whole aria-label="Whole stack: on a fresh stack, write a guide for each open layer without one, bottom to top">Whole stack</button>`,
    ].join(""),
  };
}
