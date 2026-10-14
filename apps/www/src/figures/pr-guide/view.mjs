// The hero's world plan and camera, shared by the build (geometry.mjs) and the page (live.js).
import { boxCorners, fitProjection } from "../kit/iso-kit.mjs";

export const W = 960;
export const H = 540;
/** Turned past the set's 45 degrees to show the long side: five files and the guide run along x. */
export const AZIMUTH = 58;

// World plan, in units of about a pixel: files along +x, rows along +y, z up.
export const SHEET_W = 64;
export const PITCH = 72;
export const WINDOW_H = 2.4;
export const SHEET_Z = WINDOW_H;
/** The PR window: title bar, header and tabs above the Files changed area that holds the diffs. */
export const WINDOW = { x: -9, y: -38, w: 4 * PITCH + SHEET_W + 18, d: 172, r: 3 };

// The guide stands behind the PR window. Overview and flow lead on the left; each chapter stands over the files it
// explains, so its connectors drop short and straight. The number pips on each panel give the reading order.
export const PANEL_Y = -80;
export const PANEL_Z = 26;
export const PANEL_H = 48;
export const PANELS = [
  { kind: "overview", x: -152, w: 64 },
  { kind: "flow", x: -82, w: 64 },
  { kind: "chapter", chapter: 1, x: 0, w: 136 },
  { kind: "chapter", chapter: 0, x: 144, w: 118 },
  { kind: "chapter", chapter: 2, x: 270, w: 82 },
];
/** Where revision 1 stands once revision 2 takes its place: back, up and a little along. */
export const OLD = { dx: 12, dy: -30, dz: 14 };
/** How far a guide panel rises as it forms. */
export const RISE = 6;

// The commit graph in front: the base, revision 1's three commits, and the new head that started revision 2.
export const GRAPH = { x: -12, y: WINDOW.y + WINDOW.d + 8, w: WINDOW.w + 6, d: 58, r: 3 };
// prkit's checks list, beside the PR window: one row per chapter.
export const CHECKS = { x: WINDOW.x + WINDOW.w + 10, y: 20, w: 62, d: 32, r: 2.4 };

export const P = fitProjection(
  [
    ...boxCorners(WINDOW, 0, WINDOW_H),
    ...boxCorners(GRAPH, 0, 1.6),
    ...boxCorners(CHECKS, 0, 1.6),
    [PANELS[0].x, PANEL_Y, PANEL_Z],
    [PANELS[0].x + OLD.dx, PANEL_Y + OLD.dy, PANEL_Z + PANEL_H + OLD.dz],
    [352 + OLD.dx, PANEL_Y + OLD.dy, PANEL_Z + PANEL_H + OLD.dz],
  ],
  W,
  H,
  { pad: 22, azimuth: AZIMUTH },
);
