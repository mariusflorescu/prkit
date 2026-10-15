// The local-first drawing, built once with the kit and prkit's digital materials, as an architecture diagram whose
// boxes are the software itself: your Mac's dashed boundary holds prkit's window, its server's memory with one
// token per account, your agent's terminal and prkit's data folder. One connector leaves for GitHub's API; the
// agent's own line goes to the Claude, Codex or Cursor login it runs on. Where a prkit server would be there is only a
// dashed, crossed-out, empty frame.
import * as k from "../kit/iso-kit.mjs";
import * as D from "../kit/prkit-digital.mjs";
import { ACCOUNTS } from "./model.mjs";

export const W = 640;
export const H = 480;

const { UI } = D;

// World plan, in units of about a pixel. Everything inside the boundary lies flat, so nothing stands in front of
// anything else; the far ends outside stand up.
const MAC = { x: 0, y: 0, w: 184, d: 146, r: 8 };
const SERVER = { x: 8, y: 10, w: 76, d: 50, r: 2.4 };
const APP = { x: 8, y: 70, w: 76, d: 68, r: 2.4 };
const AGENT = { x: 100, y: 10, w: 76, d: 54, r: 2.4 };
const DATA = { x: 100, y: 74, w: 76, d: 64, r: 2.4 };
const PANEL_H = 1.8;
const TOP = PANEL_H;
const GITHUB = { x: 108, y: -66, w: 64, d: 1.6, z: 6, h: 46 };
const PLAN = { x: 204, y: 30, w: 46, d: 1.6, z: 5, h: 32 };
const NONE = { x: -62, y: -40, w: 48, d: 1.6, z: 8, h: 34 };
const BAR = 6.4;

export const P = k.fitProjection(
  [
    ...k.boxCorners(MAC, 0, TOP),
    ...[GITHUB, PLAN, NONE].flatMap((panel) =>
      k.boxCorners({ ...panel, r: 0 }, panel.z, panel.z + panel.h),
    ),
  ],
  W,
  H,
  { pad: 18 },
);

// ---------------------------------------------------------------------------------------------------------------
// The lines between them, as world polylines: the pulses run along these.

const LANE = -30;
export const LINES = {
  // Out of the server's back edge, behind the boundary, across to GitHub's API.
  github: [
    [52, SERVER.y, TOP],
    [52, LANE, TOP],
    [GITHUB.x + GITHUB.w / 2, LANE, TOP],
    [GITHUB.x + GITHUB.w / 2, GITHUB.y + GITHUB.d, GITHUB.z + 2.6],
  ],
  // From the server's right edge across to the agent's terminal, on your Mac.
  agent: [
    [SERVER.x + SERVER.w, SERVER.y + 30, TOP],
    [AGENT.x, AGENT.y + 30, TOP],
  ],
  // The agent's own work: down to its copy of the branch, in prkit's data folder.
  copy: [
    [AGENT.x + 52, AGENT.y + AGENT.d, TOP],
    [AGENT.x + 52, DATA.y + BAR + 22.4, TOP],
  ],
  // The agent's own line, to the login it runs on.
  plan: [
    [AGENT.x + AGENT.w, AGENT.y + 34, TOP],
    [PLAN.x + PLAN.w / 2, AGENT.y + 34, TOP],
    [PLAN.x + PLAN.w / 2, PLAN.y + PLAN.d, PLAN.z + 2.6],
  ],
};

const lengthOf = (points) =>
  points
    .slice(1)
    .reduce((sum, point, i) => sum + Math.hypot(...point.map((v, j) => v - points[i][j])), 0);

/** The world point `along` (0 to 1) of a line's length. */
export function pointAlong(name, along) {
  const points = LINES[name];
  let left = lengthOf(points) * Math.min(1, Math.max(0, along));
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const step = Math.hypot(...b.map((v, j) => v - a[j]));
    if (left <= step || i === points.length - 1) {
      const t = step ? Math.min(1, left / step) : 0;
      return a.map((v, j) => v + (b[j] - v) * t);
    }
    left -= step;
  }
  return points[0];
}

/** How far a pulse running along `name` has moved from its start, in world units. */
export const pulseShift = (name, along) => {
  const from = LINES[name][0];
  const to = pointAlong(name, along);
  return [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
};

// ---------------------------------------------------------------------------------------------------------------
// The panels' UI, in their own units.

/** A magnifier, as a search field shows it. */
const magnifier = (cx, cy, r, tone = "mid") =>
  UI.ring(cx, cy, r, tone) +
  UI.line(
    [
      [cx + r * 0.7, cy + r * 0.7],
      [cx + r * 1.6, cy + r * 1.6],
    ],
    tone,
  );

/** The server's memory, as a memory view lists it: addresses, then cells. Each account's token sits in a cell. */
function memoryUi(w) {
  const random = D.seeded(21);
  const out = [];
  const cols = 7;
  const cell = { w: 7.6, h: 6, gap: 1.2, x: 14 };
  ACCOUNTS.forEach((_, i) => {
    out.push(
      `<g data-part="token-${i}" visibility="hidden">`,
      UI.box(cell.x - 1, 2 + i * 7.2 - 0.6, w - cell.x - 2, 7.2, {
        tone: "mid",
        fill: "tint",
        r: 1,
      }),
      `</g>`,
    );
  });
  for (let r = 0; r < 6; r++) {
    const y = 2 + r * 7.2;
    out.push(UI.text(3, y + cell.h / 2, [8], "faint", 1.4));
    for (let c = 0; c < cols; c++) {
      const x = cell.x + c * (cell.w + cell.gap);
      const token = r < ACCOUNTS.length && c === 2;
      if (token) {
        out.push(
          UI.box(x, y, cell.w * 2 + cell.gap, cell.h, { tone: "hi", fill: "paper", r: 0.8 }),
          UI.emblem(ACCOUNTS[r], x + 2.6, y + cell.h / 2, 1.5, "hi"),
          UI.key(x + 5.6, y + 1.8, 3, "hi"),
          UI.text(x + 11.4, y + cell.h / 2, [1.2, 1.2, 1.2], "mid", 1.2, 0.6),
        );
        continue;
      }
      if (r < ACCOUNTS.length && c === 3) continue;
      const fill = random();
      out.push(
        UI.box(x, y, cell.w, cell.h, { tone: "faint", fill: fill > 0.55 ? "tint" : "", r: 0.6 }),
        fill > 0.3
          ? UI.text(x + 1.6, y + cell.h / 2, [cell.w - 3.2], fill > 0.7 ? "lo" : "faint", 1.2)
          : "",
      );
    }
  }
  return out.join("");
}

/** prkit's window: the inbox, each row carrying the emblem of the account that found it. */
function inboxUi(w) {
  const random = D.seeded(5);
  const rows = ["circle", "square", "triangle", "square", "circle", "triangle", "circle"];
  const out = [
    UI.box(3, 2, w - 6, 5.6, { tone: "faint", fill: "tint", r: 2.8 }),
    magnifier(6.6, 4.5, 1.3, "lo"),
    UI.text(10.6, 4.8, [18], "faint", 1.4),
  ];
  // The row an answer from GitHub has just brought in.
  out.push(
    `<g data-part="fresh" visibility="hidden">${UI.box(2, 9.6, w - 4, 7, { tone: "hi", fill: "paper", r: 1 })}</g>`,
  );
  rows.forEach((emblem, i) => {
    const cy = 13 + i * 7.6;
    if (i)
      out.push(
        UI.line(
          [
            [3, cy - 3.8],
            [w - 3, cy - 3.8],
          ],
          "faint",
        ),
      );
    const icon =
      i % 3 === 0
        ? UI.pending(w - 6, cy, 1.8)
        : i % 3 === 1
          ? UI.passed(w - 6, cy, 1.8)
          : UI.comment(w - 7.6, cy - 1.4, 3, "mid");
    out.push(
      UI.emblem(emblem, 6, cy, 1.9, "hi"),
      UI.text(10.6, cy - 1.1, [6, 18 + random() * 22], i ? "mid" : "hi", 1.6),
      UI.text(10.6, cy + 1.7, [8 + random() * 8, 6], "faint", 1.1),
      icon,
    );
  });
  return out.join("");
}

/** The agent's terminal: its session, its environment with no GitHub token, and the prompt where it waits. */
function terminalUi(w, d) {
  const random = D.seeded(8);
  const out = [
    `<rect class="dg-tint" x="1.4" y="1.4" width="${w - 2.8}" height="${d - 2.8}" rx="1"/>`,
  ];
  const line = (i, prompt, tone = "lo") => {
    const cy = 5.2 + i * 4.6;
    return (
      (prompt ? UI.chevron(4.4, cy, 0.9, "right", "mid") : "") +
      UI.text(
        prompt ? 7.4 : 4.4,
        cy,
        [4 + random() * 8, 6 + random() * 16],
        prompt ? "mid" : tone,
        1.5,
      )
    );
  };
  out.push(line(0, true), line(1, false));
  // The environment it was given: a few variables, and no GitHub token among them.
  const env = 2 * 4.6 + 3;
  out.push(UI.box(3, env, w - 6, 14.4, { tone: "faint", fill: "paper", r: 0.8 }));
  for (let i = 0; i < 2; i++)
    out.push(
      UI.text(5.4, env + 3.4 + i * 4.2, [8 + i * 4, 1.4, 10 + random() * 12], "lo", 1.3, 0.8),
    );
  out.push(
    UI.key(5.4, env + 10, 2.6, "mid"),
    UI.text(11.4, env + 11.2, [10], "faint", 1.3),
    UI.cross(25.4, env + 11, 1.4, "hi"),
  );
  // The live prompt where the agent waits, with its caret: the kit's terminal, laid so its prompt row lands here.
  // Its own backdrop is the same tint as the session's, so it goes first and the typed rows stay on top.
  const cy = 5.2 + 8.6 * 4.6;
  out.push(
    `<g transform="translate(0 ${(cy - 5).toFixed(2)})">${D.terminalUi(w, d - (cy - 5), { lines: 0 })}</g>`,
  );
  // What it types while it works, row by row.
  for (let i = 0; i < 3; i++)
    out.push(`<g data-type="${i}" visibility="hidden">${line(i + 5.6, i === 0)}</g>`);
  return out.join("");
}

/** prkit's data folder: a search for a GitHub token with no results, then the tree, one row the agent's own copy. */
export const COPY_ROW = 2;
/** The data folder's rows, and how far the search's scan band travels down them. */
export const TREE_ROWS = 8;
export const SCAN = 5.6;
function dataUi(w) {
  const out = [
    UI.box(3, 2, w - 6, 5.6, { tone: "mid", fill: "paper", r: 2.8 }),
    magnifier(6.6, 4.5, 1.3, "mid"),
    `<g data-part="query">${UI.key(10, 3.2, 2.8, "hi")}</g>`,
    UI.text(16.6, 4.8, [6], "mid", 1.4),
    // The answer: no results.
    `<g data-part="empty" visibility="hidden">${UI.box(w - 18, 3, 12, 3.6, { tone: "hi", fill: "tint", r: 1.8 })}${UI.ring(w - 15.2, 4.8, 0.9, "hi")}${UI.text(w - 12.6, 4.8, [4], "hi", 1.2)}</g>`,
  ];
  const tree = [
    [0, "folder", [10]],
    [1, "folder", [14]],
    [2, "folder", [6, 9]],
    [1, "folder", [8]],
    [2, "file", [12]],
    [0, "file", [10, 5]],
    [0, "file", [6, 4]],
    [0, "folder", [8]],
  ];
  out.push(
    `<g data-part="scan" visibility="hidden"><rect class="dg-band" x="2" y="8.6" width="${w - 4}" height="5.4" rx="1"/></g>`,
  );
  tree.forEach(([depth, kind, lens], i) => {
    const cy = 11.4 + i * 5.6;
    const x = 4 + depth * 5;
    const copy = i === COPY_ROW;
    out.push(
      copy
        ? `<g data-part="copy-lit" visibility="hidden"><rect class="dg-lit-soft" x="2" y="${cy - 2.6}" width="${w - 4}" height="5.2" rx="1"/></g>`
        : "",
      kind === "folder" ? UI.chevron(x, cy, 0.9, "down", "mid") : "",
      UI[kind](x + 2.6, cy - 1.4, 3, copy ? "hi" : "mid"),
      UI.text(x + 7, cy, lens, copy ? "mid" : "lo", 1.5),
    );
  });
  return out.join("");
}

/** GitHub's API, as a response viewer shows it: braces, keys and values, one entry per account. */
function apiUi(w) {
  const out = [];
  const brace = (x, dir) =>
    UI.line(
      [
        [x + dir * 2, 2.4],
        [x, 2.4],
        [x, 15],
        [x - dir, 16.2],
        [x, 17.4],
        [x, 31],
        [x + dir * 2, 31],
      ],
      "hi",
    );
  out.push(brace(4, 1), brace(w - 4, -1));
  ACCOUNTS.forEach((emblem, i) => {
    const cy = 6.4 + i * 8.6;
    out.push(
      `<g data-part="api-${i}" visibility="hidden">${UI.box(6.4, cy - 3.4, w - 12.8, 6.8, { tone: "", fill: "tint", r: 1 })}</g>`,
      UI.emblem(emblem, 10, cy, 1.6, "hi"),
      UI.text(13.4, cy - 1, [8, 12 + i * 3], "mid", 1.4),
      UI.text(13.4, cy + 1.6, [6 + i * 2, 10], "lo", 1.2),
    );
  });
  return out.join("");
}

/** The login your agent runs on: an avatar and its plan. */
function planUi(w) {
  return (
    UI.avatar(8, 7, 3.4, "circle", "hi") +
    UI.text(14, 5.8, [14, 8], "mid", 1.6) +
    UI.text(14, 9, [10], "lo", 1.2) +
    UI.box(4, 13.6, w - 8, 6, { tone: "mid", fill: "tint", r: 3 }) +
    UI.check(8, 16.6, 2.4, "hi") +
    UI.text(12, 16.6, [16], "mid", 1.4)
  );
}

// ---------------------------------------------------------------------------------------------------------------

/**
 * A pulse on a line, as a diagram animates a request: a dot running along the connector, filled on its way out and
 * hollow on its way back. Nothing else travels; what arrives shows at the far end.
 */
function pulseSvg(name, out) {
  const [x, y] = k.iso(LINES[name][0], P);
  const at = `cx="${x.toFixed(1)}" cy="${y.toFixed(1)}"`;
  return `<g data-pulse="${name}-${out ? "out" : "back"}" visibility="hidden"><circle class="lo-halo" ${at} r="5.4"/>${
    out
      ? `<circle class="dg-pill" data-tone="hi" ${at} r="2.6"/>`
      : `<circle class="dg-paper" ${at} r="2.6"/><circle class="dg-stroke" data-tone="hi" data-bold ${at} r="2.6"/>`
  }</g>`;
}

const lineSvg = (name, tone, dashed = false) =>
  k
    .lineSvg(k.pathOf(LINES[name].map((point) => k.iso(point, P))), {
      tone,
      dashed,
      className: `lo-line`,
    })
    .replace("<path ", `<path data-line="${name}" `) +
  k.dotsSvg(
    [LINES[name][0], LINES[name][LINES[name].length - 1]].map((point) => k.iso(point, P)),
    { size: 0.9, tone: "hi" },
  );

export function drawing() {
  const out = [];
  // The boundary: your Mac, a dashed outline on the ground with a computer glyph in its corner.
  out.push(
    `<g transform="${D.faceTop(MAC.x, MAC.y, 0, P)}">${UI.box(0, 0, MAC.w, MAC.d, { tone: "mid", fill: "", r: MAC.r, dash: true })}${UI.box(5, MAC.d - 10, 8, 5.2, { tone: "mid", fill: "", r: 0.6 })}${UI.line(
      [
        [9, MAC.d - 4.8],
        [9, MAC.d - 3.4],
      ],
      "mid",
    )}${UI.line(
      [
        [6.8, MAC.d - 3.4],
        [11.2, MAC.d - 3.4],
      ],
      "mid",
    )}</g>`,
  );
  // Where a prkit server would be: an empty dashed frame, crossed out, joined to nothing.
  out.push(
    `<g opacity=".75" transform="${D.faceFront(NONE.x, NONE.y + NONE.d, NONE.z + NONE.h, P)}">${UI.box(0, 0, NONE.w, NONE.h, { tone: "lo", fill: "", r: 1.4, dash: true })}${UI.box(0.6, 0.6, NONE.w - 1.2, BAR - 0.6, { tone: "", fill: "tint", r: 1 })}${[0, 1, 2].map((i) => UI.ring(3 + i * 2.6, BAR / 2 + 0.3, 0.8, "lo", true)).join("")}${UI.cross(NONE.w / 2, NONE.h / 2 + 3, 6, "lo")}</g>`,
  );
  // The line out, behind the boundary, and GitHub's API at its end.
  out.push(
    lineSvg("github", "hi"),
    D.uprightPanelSvg(GITHUB, GITHUB.z, GITHUB.h, P, {
      title: [10, 6],
      body: (w) => apiUi(w),
    }),
  );
  // Inside: the server's memory, the window, the agent's terminal, the data folder.
  out.push(
    D.flatPanelSvg(SERVER, 0, P, { h: PANEL_H, title: [12, 6], body: (w) => memoryUi(w) }),
    D.flatPanelSvg(AGENT, 0, P, { h: PANEL_H, title: [10], body: (w, d) => terminalUi(w, d) }),
    D.flatPanelSvg(APP, 0, P, { h: PANEL_H, title: [8, 14], body: (w) => inboxUi(w) }),
    D.flatPanelSvg(DATA, 0, P, { h: PANEL_H, title: [12], body: (w) => dataUi(w) }),
  );
  out.push(lineSvg("agent", "mid"), lineSvg("copy", "mid"), lineSvg("plan", "lo", true));
  out.push(
    D.uprightPanelSvg(PLAN, PLAN.z, PLAN.h, P, {
      title: [8],
      body: (w) => planUi(w),
    }),
  );
  // The pulses, over everything, hidden until the tour sends one.
  out.push(
    pulseSvg("github", true),
    pulseSvg("github", false),
    pulseSvg("agent", true),
    pulseSvg("agent", false),
  );
  return out.join("");
}
