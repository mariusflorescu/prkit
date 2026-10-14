/**
 * The hero figure's card, built at build time: a pull request window holding five file diffs, your agent reading
 * them, and the guide forming behind them, each chapter tied by connector lines to the exact lines it explains.
 */
import * as k from "../kit/iso-kit.mjs";
import { DIGITAL_CSS } from "../kit/prkit-digital.mjs";
import { legend } from "../kit/prkit-frame.ts";
import { H, W, drawing } from "./geometry.mjs";
import { CHAPTERS, FILES, MOMENTS, STILL, stateAt } from "./model.mjs";

/** The cursor solid and its glow a step stronger than the kit's, so the agent is the first thing the eye finds. */
const STYLE = `${DIGITAL_CSS}.pg-hero .pg-glow-core{stop-color:var(--anatomy-lit);stop-opacity:.5}.pg-hero [data-part="agent"] .dg-face{fill-opacity:.9}.pg-hero [data-part="agent"] .dg-face[data-light="0"]{fill-opacity:1}`;

export function figure() {
  const still = stateAt(STILL);
  const svg = k.figureSvg({
    width: W,
    height: H,
    className: "pg-hero",
    label: `A pull request window with its number, title, base and head branches and checks, and under its Files changed tab the ${FILES.length} changed files as diff panels: added lines raised, removed lines sunk and hollow, each file checked off as read, with the agent's one-line note under its header. Behind it the guide stands as app panels: an overview, a before and after flow, and ${CHAPTERS.length} chapters, each over the files it explains and joined by connector lines to the exact line ranges it covers. Your agent, drawn as a rose terminal block cursor, shines on a line of the test file as it lands the last chapter's anchor. In front, a commit graph shows a commit just appended, touching the test file; revision 1 of the guide is tagged on the commit before it and stands back, dimmed, while revision 2 forms from what changed. A checks list beside the window shows ${still.settled} of ${CHAPTERS.length} chapters checked.`,
    body: [`<style>${STYLE}</style>`, drawing().body],
  });
  return {
    svg,
    title: "A guide being written",
    hint: "Pick a step",
    caption: `Your own agent reads all ${FILES.length} changed files and writes the guide: an overview, a before and after flow, then ${CHAPTERS.length} chapters, core change first. prkit shows a chapter once every anchor lands on real lines of the diff. A new commit starts revision 2 and revision 1 stays readable. Then you decide: comment, approve or request changes.`,
    legend: legend([
      { mark: "lit", label: "Rose: your agent, and what it touches" },
      { mark: "raised", label: "Raised rows: added lines" },
      { mark: "flat", label: "Sunk, hollow rows: removed lines" },
    ]),
    controls: MOMENTS.map(
      (moment, index) =>
        `<button type="button" data-moment="${index}" aria-pressed="${STILL >= moment.from && STILL < moment.to}" aria-label="${moment.label}: ${moment.name}">${moment.label}</button>`,
    ).join(""),
  };
}
