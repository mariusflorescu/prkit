// The inbox list's world plan and camera, shared by the build (geometry.mjs) and the page (live.js).
import { boxCorners, fitProjection, slabOf } from "../kit/iso-kit.mjs";
import { MEMBERS, PULLS } from "./model.mjs";

export const WIDTH = 640;
export const HEIGHT = 420;
/** Turned well past the set's 45 degrees, so the rows run nearly level and the list runs down the page, as on a screen. */
export const AZIMUTH = 66;

// World units are about a pixel at 1x. The window lies flat, its rows along +x and the list running down +y.
export const WIN = { x: 0, y: 0, w: 118, d: 167, r: 3 };
export const WIN_H = 2;
/** The group cards stand on the window, this thick. */
export const CARD_H = 1;
export const CARD = { x: 5, w: 108 };
/** The account select in the toolbar, and its popup under it, floating over the list. */
export const SELECT = { x: 57, y: 16.5, w: 30, d: 7, r: 2 };
export const POPUP = { x: 57, y: 25, w: 42, d: 31, r: 1.6 };
export const POPUP_Z = WIN_H + CARD_H + 3.4;
export const POPUP_ROW = 7;

// The list: groups from LIST_Y down, each a header then its rows.
export const LIST_Y = 29;
export const HEADER = 9;
export const PITCH = 10;
export const PAD = 2;
export const GAP = 4.5;

export const P = fitProjection(
  [...boxCorners(WIN, 0, WIN_H), ...boxCorners(POPUP, POPUP_Z, POPUP_Z + 1.2)],
  WIDTH,
  HEIGHT,
  { pad: 16, azimuth: AZIMUTH },
);

/**
 * Where every group card and row sits, from how present each row and group is (1 shown, 0 gone). A row that goes
 * takes its height with it, and a group that goes takes its header and the gap after it.
 */
export function layoutOf(rows, groups) {
  const at = PULLS.map(() => 0);
  let y = LIST_Y;
  const cards = MEMBERS.map((members, group) => {
    const shown = groups[group];
    const top = y;
    let ry = y + HEADER * shown;
    for (const index of members) {
      at[index] = ry;
      ry += PITCH * rows[index];
    }
    const d = ry - y + PAD * shown;
    y += d + GAP * shown;
    return { y: top, d, shown };
  });
  return { cards, rows: at };
}

/** A group card's outline at a given place and depth, for the build and for live.js as the list narrows. */
export const cardPaths = ({ y, d }) =>
  slabOf(
    { x: CARD.x, y, w: CARD.w, d: Math.max(0.02, d), r: Math.min(2, Math.max(0.01, d / 2)) },
    WIN_H,
    CARD_H,
    P,
    3,
    0.4,
  );
