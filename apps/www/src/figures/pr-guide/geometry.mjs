// The hero's drawing, built once with the kit and prkit's digital materials, every part drawn the way software
// shows it: the pull request as a PR window whose Files changed area holds the five file diffs, the agent as a
// terminal cursor reading them, and the guide standing behind as app panels, each chapter over the files it
// explains and joined by connector lines to the exact line ranges. Revision 1 stands back as dimmed glass while
// revision 2 forms; the commit graph in front tags each revision's commit, and a checks list shows prkit's check.
//
// It is drawn at the tour's still moment, and every part the page moves carries a `data-part` name.
import * as A from "../kit/audit.mjs";
import * as k from "../kit/iso-kit.mjs";
import * as D from "../kit/prkit-digital.mjs";
import {
  CHAPTERS,
  FILES,
  ORDER,
  STILL,
  anchorRowOf,
  readRowsOf,
  rowsOf,
  stateAt,
} from "./model.mjs";
import {
  CHECKS,
  GRAPH,
  OLD,
  P,
  PANELS,
  PANEL_H,
  PANEL_Y,
  PANEL_Z,
  PITCH,
  SHEET_W,
  SHEET_Z,
  WINDOW,
  WINDOW_H,
} from "./view.mjs";

export { H, P, W } from "./view.mjs";

const sheetOf = (index) => ({ x: index * PITCH, y: 0, w: SHEET_W });
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const floating = (name) => ({ name, ground: true });
const GRAPH_SCALE = 1.5;

/** Where each panel comes in the writing order. */
const orderOf = (panel) =>
  ORDER.findIndex((o) => o.kind === panel.kind && o.chapter === panel.chapter);
/** The cursor, as a terminal draws it, stood up big enough to read at 1x. */
const CURSOR = { w: 13, d: 5, h: 19, prompt: 4.2 };
const CURSOR_Z = SHEET_Z + 46;
const still = stateAt(STILL);
/** The chapter being written at the still. */
const WRITING = still.settled;

let built;

/** The whole drawing, at the tour's still moment. */
export function drawing() {
  if (built) return built;
  const S = D.sceneOf(P);
  const over = D.sceneOf(P);

  const sheets = FILES.map((file, index) => ({ index, sheet: sheetOf(index), ...rowsOf(file) }));
  const markTop = (sheet, hunk) => D.rowY(sheet, hunk[0]) - D.SHEET.pitch / 2 + 0.25;

  // Each chapter's sockets sit over its files; each thread lands on the top edge of the file's first hunk.
  for (const panel of PANELS) {
    if (panel.kind !== "chapter") continue;
    panel.links = CHAPTERS[panel.chapter].files.map((fileIndex) => {
      const { sheet, hunks } = sheets[fileIndex];
      const sx = clamp(sheet.x + SHEET_W / 2, panel.x + 8, panel.x + panel.w - 8);
      const tx = clamp(sx, sheet.x + D.SHEET.gutter + 2, sheet.x + SHEET_W - 5);
      return { fileIndex, sx, to: [tx, markTop(sheet, hunks[0]) + 0.4] };
    });
  }

  // The guide: revision 1 as dimmed glass, stepped back, then revision 2.
  for (const old of [true, false]) {
    PANELS.forEach((panel, index) => {
      const plan = {
        x: panel.x + (old ? OLD.dx : 0),
        y: PANEL_Y + (old ? OLD.dy : 0),
        w: panel.w,
        d: 1.6,
      };
      const z = PANEL_Z + (old ? OLD.dz : 0);
      const isChapter = panel.kind === "chapter";
      const writing = !old && isChapter && panel.chapter === WRITING;
      const p = D.guidePanelSvg(plan, z, PANEL_H, P, {
        kind: panel.kind,
        badge: isChapter ? CHAPTERS[panel.chapter].kind : "core",
        number: isChapter ? panel.chapter + 1 : 0,
        revision: old ? 1 : 2,
        seed: 40 + index,
        lit: writing,
        sockets: isChapter ? panel.links.map((link) => link.sx + (old ? OLD.dx : 0)) : 0,
        dim: old,
      });
      const halo = old
        ? ""
        : `<path class="iso-halo" style="opacity:.45" d="${k.slabOf({ x: plan.x + 4, y: plan.y - 4, w: plan.w - 8, d: 8, r: 3 }, 0, 0.1, P).fill}"/>`;
      S.put(
        [plan.x + plan.w / 2, plan.y, z + PANEL_H / 2],
        `<g data-part="r${old ? 1 : 2}-${orderOf(panel)}">${halo + p.svg}</g>`,
        0,
        [A.slab({ ...plan, r: 0.6 }, z, PANEL_H, floating("guide.panel"), 2)],
        `guide.${old ? "r1" : "r2"}.${panel.kind}${isChapter ? panel.chapter + 1 : ""}`,
      );
      if (!old && isChapter) panel.sockets = p.sockets;
    });
  }

  // The PR window: number and title, base <- head, people, the checks badge, then the tabs with Files changed open.
  const header = (w) => {
    const U = D.UI;
    return [
      U.line(
        [
          [5.4, 2],
          [4.8, 7.4],
        ],
        "hi",
      ) +
        U.line(
          [
            [7.6, 2],
            [7, 7.4],
          ],
          "hi",
        ),
      U.line(
        [
          [4, 3.8],
          [8.6, 3.8],
        ],
        "hi",
      ) +
        U.line(
          [
            [3.8, 5.6],
            [8.4, 5.6],
          ],
          "hi",
        ),
      U.text(11, 4.7, [7, 34, 20, 26], "hi", 3),
      U.passed(w - 14, 4.7, 2.6),
      U.text(w - 10, 4.7, [6], "mid", 1.6),
      ["circle", "square", "triangle"]
        .map((emblem, i) => U.avatar(w - 46 + i * 7, 4.7, 2.6, emblem))
        .join(""),
      U.box(4, 10.6, 26, 4.4, { tone: "lo", fill: "tint", r: 2.2 }) +
        U.text(7, 12.8, [20], "lo", 1.6),
      U.line(
        [
          [42, 12.8],
          [33.4, 12.8],
        ],
        "hi",
      ) +
        U.line(
          [
            [35.6, 11.2],
            [33.4, 12.8],
            [35.6, 14.4],
          ],
          "hi",
        ),
      U.box(45, 10.6, 34, 4.4, { tone: "hi", fill: "tint", r: 2.2 }) +
        U.text(48, 12.8, [28], "mid", 1.6),
      U.text(84, 12.8, [16, 10, 22], "faint", 1.6),
      U.line(
        [
          [2, 25],
          [w - 2, 25],
        ],
        "faint",
      ),
      [16, 14, 12, 22]
        .map((len, i, all) => {
          const x = 6 + all.slice(0, i).reduce((a, b) => a + b + 8, 0);
          const open = i === all.length - 1;
          return (
            U.text(x, 21, [len], open ? "hi" : "lo", 1.8) +
            (open
              ? U.line(
                  [
                    [x - 1, 25],
                    [x + len + 1, 25],
                  ],
                  "hi",
                ) + U.dot(x + len + 4, 21, 1.6, "mid")
              : "")
          );
        })
        .join(""),
    ].join("");
  };
  S.put(
    [WINDOW.x + WINDOW.w / 2, WINDOW.y + WINDOW.d / 2, 0],
    D.flatPanelSvg(WINDOW, 0, P, { h: WINDOW_H, body: header, title: [18, 10] }),
    0,
    [A.slab(WINDOW, 0, WINDOW_H, { name: "pr.window", ground: true }, 3)],
    "pr.window",
  );

  // The files, each checked off as read, with the agent's one-line note under its header.
  const drawn = sheets.map(({ index, sheet, kinds, hunks }) => {
    const marks = CHAPTERS.flatMap((chapter) => (chapter.files.includes(index) ? hunks : []));
    const f = D.fileSheetSvg(sheet, SHEET_Z, P, {
      code: D.codeOf(kinds, 101 + index * 7),
      seed: 3 + index,
      glyph: index === 4 ? "triangle" : "page",
      marks,
      read: true,
      note: true,
      part: `file-${index}`,
    });
    const plan = { ...f.plan };
    S.put(
      [plan.x + plan.w / 2, plan.y + plan.d / 2, SHEET_Z],
      f.svg,
      0,
      [A.slab(plan, SHEET_Z, D.SHEET.h, { name: "file.sheet" }, 3)],
      `file.${index}`,
    );
    return { f };
  });

  // The commit graph: revision 1's guide is tagged on its last commit, revision 2's on the commit just appended.
  S.put(
    [GRAPH.x + GRAPH.w / 2, GRAPH.y + GRAPH.d / 2, 0],
    D.flatPanelSvg(GRAPH, 0, P, {
      title: [14, 8],
      // Drawn half again larger than the kit's default, so nodes, SHAs and ref tags read at 1x.
      body: (w, d) =>
        `<g transform="scale(${GRAPH_SCALE})">${D.commitGraphUi(w / GRAPH_SCALE, d / GRAPH_SCALE, {
          base: 2,
          head: 4,
          fresh: 3,
          // Revision 2 is tagged once accepted: at the still its last chapter is still being checked.
          refs: { 2: { pips: 1, dim: true }, 3: { pips: 2, hidden: true } },
          part: "graph",
        })}</g>`,
    }),
    0,
    [A.slab(GRAPH, 0, 1.6, { name: "commit.graph", ground: true }, 3)],
    "commit.graph",
  );

  // prkit's checks list: a chapter passes once every anchor lands on real lines of the diff.
  S.put(
    [CHECKS.x + CHECKS.w / 2, CHECKS.y + CHECKS.d / 2, 0],
    D.flatPanelSvg(CHECKS, 0, P, {
      title: [12],
      body: (w) =>
        D.checksUi(
          w,
          CHAPTERS.map((_, i) => (i < still.settled ? "pass" : "pending")),
          { part: "check" },
        ),
    }),
    0,
    [A.slab(CHECKS, 0, 1.6, { name: "checks.list", ground: true }, 3)],
    "checks.list",
  );

  // Anchor connectors, short and straight: each chapter's to the first hunk of every file it explains.
  const threads = [];
  for (const panel of PANELS) {
    if (panel.kind !== "chapter") continue;
    const writing = panel.chapter === WRITING;
    panel.links.forEach((link, i) => {
      const { f } = drawn[link.fileIndex];
      const to = [link.to[0], link.to[1], f.top];
      const from = panel.sockets[i];
      threads.push(
        `<g data-part="anchor-${panel.chapter}-${i}">${D.connectorSvg(from, to, P, { tone: writing ? "lit" : "mid" })}</g>`,
      );
    });
  }
  over.put([0, 0, 0], threads.join(""));

  // The agent: a block cursor over the files, its beam on the line it reads. It is drawn at the still, landing the
  // last chapter's anchor; every other place the tour sends it is a stop, measured here in screen offsets.
  const top = drawn[0].f.top;
  const readPlace = (fileIndex, row) => {
    const { f } = drawn[fileIndex];
    const at = f.rows[row];
    return {
      cursor: [sheetOf(fileIndex).x + 42, at.y - 16, CURSOR_Z],
      beam: [
        [at.x0 - 1, at.y, at.z],
        [at.x1 + 1, at.y, at.z],
      ],
      line: [
        [sheetOf(fileIndex).x + D.SHEET.gutter - 2, at.y, at.z + 0.05],
        [sheetOf(fileIndex).x + SHEET_W, at.y, at.z + 0.05],
      ],
    };
  };
  const places = {};
  FILES.forEach((file, index) =>
    readRowsOf(file).forEach((row, step) => {
      places[`read-${index}-${step}`] = readPlace(index, row);
    }),
  );
  CHAPTERS.forEach((chapter, c) =>
    chapter.files.forEach((fileIndex, link) => {
      places[`anchor-${c}-${link}`] = readPlace(fileIndex, anchorRowOf(FILES[fileIndex]));
    }),
  );
  ORDER.forEach((_, order) => {
    const panel = PANELS.find((p) => orderOf(p) === order);
    places[`panel-${order}`] = {
      cursor: [clamp(panel.x + panel.w / 2, -40, 320), WINDOW.y + 12, CURSOR_Z + 6],
    };
  });
  const rest = places[`anchor-${WRITING}-0`];
  const node = rest.cursor;
  const screen = (point) => k.iso(point, P).map((v) => Math.round(v * 10) / 10);
  const offset = (point, from) => {
    const [a, b] = screen(point);
    const [c, d] = screen(from);
    return [Math.round((a - c) * 10) / 10, Math.round((b - d) * 10) / 10];
  };
  const ground = ([x, y]) => [x, y, top];
  const stops = Object.fromEntries(
    Object.entries(places).map(([name, place]) => [
      name,
      {
        c: offset(place.cursor, node),
        s: offset(ground(place.cursor), ground(node)),
        ...(place.beam ? { r: place.beam.flatMap(screen), l: place.line.flatMap(screen) } : {}),
      },
    ]),
  );
  const foot = screen(node);
  const beam = [foot, screen(rest.beam[0]), screen(rest.beam[1])];
  const defs = `<defs><linearGradient id="pg-beam" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="dg-beam-hi"/><stop offset="1" class="dg-beam-lo"/></linearGradient><radialGradient id="pg-glow"><stop offset="0" class="pg-glow-core"/><stop offset="1" class="dg-glow-edge"/></radialGradient></defs>`;
  const shadow = `<path data-part="agent-shadow" class="iso-halo" style="opacity:.3" d="${k.ring(node[0], node[1], 6, top, P, 20)}"/>`;
  const read =
    `<path data-part="beam" d="${k.pathOf(beam, true)}" fill="url(#pg-beam)"/>` +
    k
      .lineSvg(k.pathOf([rest.line[0], rest.line[1]].map((p) => k.iso(p, P))), { tone: "lit" })
      .replace("<path", '<path data-part="read-line"');
  const [gx, gy] = k.iso([node[0], node[1], node[2] + CURSOR.h / 2], P);
  const glow = `<ellipse cx="${gx.toFixed(1)}" cy="${gy.toFixed(1)}" rx="${(CURSOR.w * 4).toFixed(1)}" ry="${(CURSOR.h * 2.6).toFixed(1)}" fill="url(#pg-glow)"/>`;
  over.put(
    [1, 0, 0],
    defs +
      shadow +
      read +
      `<g data-part="agent" data-stops='${JSON.stringify({ foot, stops })}'>${glow}${D.blockCursorSvg(node, P, CURSOR)}</g>`,
  );

  built = { R: S.R, body: D.slimSvg(S.body({ settle: true }) + over.body()) };
  return built;
}
