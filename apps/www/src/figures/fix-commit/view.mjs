// The fix figure's world plan and camera, shared by the build (geometry.mjs) and the page (live.js). Things happen
// left to right along the back, then come forward: the review threads on the diff, the agent's terminal, the
// agent's own copy of the file, then the Fixes card with the commit and Push, fed by prkit's token.
import { boxCorners, fitProjection } from "../kit/iso-kit.mjs";

export const WIDTH = 640;
export const HEIGHT = 480;
/** The hero's camera: turned past 45 degrees so rows of UI run nearly level. */
export const AZIMUTH = 58;

export const SHEET_W = 66;
/** The pull request's diff, where the review threads sit. */
export const DIFF = { x: 0, y: 0, w: SHEET_W };
/** The agent's terminal, standing behind, facing the reader. */
export const TERM = { x: 70, y: -34, w: 72, d: 1.6 };
export const TERM_Z = 4;
export const TERM_H = 44;
/** The agent's own checkout of the same file. */
export const COPY = { x: 126, y: -20, w: SHEET_W };
/** The Fixes tab's card for this turn. */
export const CARD = { x: 120, y: 84, w: 126, d: 78, r: 2.4 };
/** Who holds the token: prkit's process, and the agent's environment. */
export const KEYS = { x: 6, y: 104, w: 100, d: 48, r: 2.4 };
export const PANEL_H = 1.6;

export const P = fitProjection(
  [
    ...boxCorners({ ...DIFF, d: 76, r: 0 }, 0, 2),
    ...boxCorners({ ...COPY, d: 76, r: 0 }, 0, 2),
    ...boxCorners({ ...COPY, y: COPY.y - 9, d: 4, r: 0 }, 0, 2),
    ...boxCorners({ ...TERM, r: 0 }, TERM_Z, TERM_Z + TERM_H),
    ...boxCorners(CARD, 0, PANEL_H),
    ...boxCorners(KEYS, 0, PANEL_H),
  ],
  WIDTH,
  HEIGHT,
  { pad: 18, azimuth: AZIMUTH },
);

/** One line of the terminal, in its own units. */
export const TERM_PITCH = 4.6;
/** Where the commit graph's commits sit along the card, in its own units. */
export const GRAPH = { y: 45, head: 51, nodes: [36, 52, 68], fresh: 84, base: [9, 21] };
