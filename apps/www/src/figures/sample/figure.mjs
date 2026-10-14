/**
 * The sample figure's card, built at build time: a dial indicator on a surface plate. It proves the
 * figure contract end to end (README.md) and lives only on the hidden /figures/sample page.
 */
import * as k from "../kit/iso-kit.mjs";
import { legend } from "../kit/prkit-frame.ts";
import {
  HEIGHT,
  P,
  WIDTH,
  carriage,
  dial,
  fixture,
  needleAt,
  plate,
  plunger,
  rails,
} from "./geometry.mjs";
import { BLOCKS, CARRIAGE_TOP, STOPS, turnsAt } from "./model.mjs";

export function figure() {
  const rest = CARRIAGE_TOP + BLOCKS[0];
  const svg = k.figureSvg({
    width: WIDTH,
    height: HEIGHT,
    label: `A dial indicator on a surface plate. Its plunger rests on one of three gauge blocks, ${BLOCKS.join(", ")} tall, on a carriage that slides along two rails; the needle turns by the height of the block under it.`,
    body: [
      plate(),
      rails(),
      fixture(),
      `<g data-part="carriage" transform="${k.translateAlong(P, [STOPS[0], 0, 0])}">${carriage()}</g>`,
      `<g data-part="plunger" transform="${k.translateAlong(P, [0, 0, rest])}">${plunger()}</g>`,
      dial(),
      `<path data-part="needle" class="iso-line" data-tone="lit" data-free="start" d="${needleAt(turnsAt(rest))}" style="stroke-width:1.1"/>`,
    ],
  });
  return {
    svg,
    title: "Dial indicator",
    hint: "Pick a block",
    caption: `A dial indicator on a surface plate. Slide the carriage and the plunger rides onto the block beneath it; one turn of the needle is 20 units of travel, so each block reads its own height.`,
    legend: legend([
      { mark: "lit", label: "Plunger and needle: what moves when the height changes" },
      { mark: "raised", label: `Three gauge blocks, ${BLOCKS.join(", ")} tall` },
    ]),
    controls: BLOCKS.map(
      (height, index) =>
        `<button type="button" data-block="${index}" aria-pressed="${index === 0}" aria-label="Slide block ${index + 1}, ${height} tall, under the plunger">Block ${index + 1}</button>`,
    ).join(""),
  };
}
