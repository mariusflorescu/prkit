// The fix figure's drawing, built once at build time with the kit and prkit's digital materials, every part drawn
// the way software shows it: the pull request's diff with two inline review threads, the agent's terminal session,
// the agent's own checkout of the file where its edits land, the Fixes tab's card for the turn (the report, the
// commit, the branch one ahead of GitHub's, Push), and the two environments: prkit's, holding the token, and the
// agent's, without one. live.js shows and hides the parts named with data-part; nothing is rebuilt on the page.
import * as k from "../kit/iso-kit.mjs";
import * as D from "../kit/prkit-digital.mjs";
import { READY, THREADS } from "./model.mjs";
import { partsOf } from "./parts.mjs";
import {
  CARD,
  COPY,
  DIFF,
  GRAPH,
  KEYS,
  P,
  PANEL_H,
  SHEET_W,
  TERM,
  TERM_H,
  TERM_PITCH,
  TERM_Z,
} from "./view.mjs";

const { UI } = D;
const n1 = (value) => Math.round(value * 100) / 100;
/** The drawing is built in the ready state, so it reads without JavaScript; live.js moves from there. */
const AT_REST = partsOf(READY);
const attrsOf = (part) => {
  const look = AT_REST[part];
  if (!look) return "";
  return (
    (look.opacity !== undefined && look.opacity < 1 ? ` opacity="${look.opacity}"` : "") +
    (look.transform ? ` transform="${look.transform}"` : "")
  );
};
const hidden = (part, svg) => `<g data-part="${part}"${attrsOf(part)}>${svg}</g>`;

/** The few looks the digital kit has no class for. */
export const STYLE = `
.fc-pulse{fill:none;stroke-width:1.7px;stroke-linecap:round;stroke-dasharray:.16 2;stroke-dashoffset:.16}
.fc-primary>.iso-top{fill:var(--anatomy-hi)}
.fc-on-primary{fill:var(--anatomy-top);stroke:none}
.fc-hit{fill:transparent;stroke:none}
[data-figure="fix-commit"] button[data-push][aria-disabled="true"]{opacity:.4;color:var(--muted-foreground);cursor:default;transform:none}
`;

// ---------------------------------------------------------------------------------------------------------------
// The diff, with its review threads.

// No removed line here: the kit's strike on one ends short of the line check. Removed lines show in the copy.
const DIFF_CODE = D.codeOf(
  ["hunk", "ctx", "ctx", "add", "add", "ctx", "ctx", "hunk", "ctx", "add", "ctx", "ctx"],
  31,
);
// The agent's copy: the same file in its checkout, before its edits. A blank line waits where each new line goes.
const COPY_KINDS = [
  "ctx",
  "ctx",
  "ctx",
  "ctx",
  "blank",
  "ctx",
  "ctx",
  "ctx",
  "ctx",
  "blank",
  "ctx",
  "ctx",
];
const COPY_CODE = D.codeOf(COPY_KINDS, 44);
/** Each edit: the line it replaces (or none) and the line it writes, as rows of the copy. */
const EDITS = [
  { removes: 3, writes: 4 },
  { removes: -1, writes: 9 },
];
const NEW_LINES = D.codeOf(["ctx", "ctx", "ctx"], 58).slice(1);

function diffSvg(S, over) {
  const sheet = D.fileSheetSvg(DIFF, 0, P, {
    code: DIFF_CODE,
    seed: 2,
    glyph: "page",
    notes: THREADS.length,
  });
  const at = [DIFF.x + SHEET_W / 2, sheet.d / 2, 0];
  S.put(at, sheet.svg);
  const sockets = [];
  THREADS.forEach((thread, i) => {
    const row = sheet.rows[thread.row];
    const card = { x: DIFF.x + 17, y: row.y + 2.6, w: 46, d: 8 + thread.replies * 6, r: 1.2 };
    const ui = D.threadUi(0, 0, card.w, {
      replies: thread.replies,
      emblem: thread.emblem,
      seed: 7 + i,
    });
    // Picked for the batch: the thread's checkbox fills and takes a tick.
    const box = card.w - 5;
    const tick = `<rect class="dg-pill" data-tone="hi" x="${box}" y="2.2" width="3.2" height="3.2" rx=".5"/><path class="dg-stroke" style="stroke:var(--anatomy-top)" d="M${n1(box + 0.7)} 3.8L${n1(box + 1.5)} 4.6L${n1(box + 2.6)} 2.9"/>`;
    S.on(
      at,
      k.solidSvg(k.slabOf(card, sheet.top, 0.8, P, 2, 0.3), {
        tone: "hi",
        crease: "faint",
        halo: true,
      }) +
        `<g transform="${D.faceTop(card.x, card.y, sheet.top + 0.8, P)}">${ui.svg}${hidden(`tick-${i}`, tick)}</g>`,
      2 + i,
    );
    // The thread is pinned to its line: a bar in the gutter beside it.
    S.on(
      at,
      `<path class="dg-pill" data-tone="hi" d="${k.planOutline({ x: DIFF.x + 1.4, y: row.y - 2, w: 1.1, d: 4, r: 0.5 }, sheet.top, P, 2)}"/>`,
      1,
    );
    sockets.push([card.x + box + 1.6, card.y + 3.8, sheet.top + 0.8]);
  });
  // The batch goes to the agent: one line from each picked thread to the terminal, and a dash that runs along it.
  sockets.forEach((from, i) => {
    const to = [TERM.x + 12 + i * 9, TERM.y + TERM.d, TERM_Z];
    const d = D.threadPath(from, to, P, 0.04);
    over.put(
      [0, 0, i],
      hidden(`send-line-${i}`, D.connectorSvg(from, to, P, { tone: "mid", sag: 0.04 })) +
        `<path class="iso-line fc-pulse" data-tone="hi" data-part="send-pulse-${i}" pathLength="2" opacity="0" d="${d}"/>`,
    );
  });
}

// ---------------------------------------------------------------------------------------------------------------
// The agent's terminal: its session, the batch arriving as one turn, its edits, and its report. The rose block
// cursor is the agent.

const TERM_LINES = [
  { prompt: true, lens: [6, 9], tone: "mid", part: "" },
  { prompt: false, lens: [12, 7, 5], tone: "lo", part: "" },
  { prompt: true, lens: [5, 4, 4], tone: "hi", part: "term-batch" },
  { prompt: false, lens: [6, 15], tone: "lo", part: "term-edit-0" },
  { prompt: false, lens: [6, 11], tone: "lo", part: "term-edit-1" },
  { prompt: false, lens: [13, 7], tone: "mid", part: "term-report" },
];

function terminalBody(w, h) {
  const out = [
    `<rect class="dg-tint" x="1" y="1" width="${n1(w - 2)}" height="${n1(h - 2)}" rx="1"/>`,
  ];
  TERM_LINES.forEach((line, i) => {
    const cy = 5 + i * TERM_PITCH;
    const x = line.prompt ? 7 : 4;
    const svg =
      (line.prompt ? UI.chevron(4, cy, 0.9, "right", line.tone === "hi" ? "hi" : "mid") : "") +
      UI.text(x, cy, line.lens, line.tone, 1.6);
    out.push(line.part ? hidden(line.part, svg) : svg);
  });
  // The idle prompt waits on the third line, before the batch comes in.
  out.push(hidden("term-idle", UI.chevron(4, 5 + 2 * TERM_PITCH, 0.9, "right", "hi")));
  // The cursor: a block and its underline stub, moved line to line by live.js.
  out.push(
    `<g data-part="term-cursor"${attrsOf("term-cursor")}><rect class="dg-lit-fill" x="7" y="3.2" width="2.8" height="3.6" rx=".3"/><rect class="dg-lit-fill" x="10.6" y="6.2" width="2.6" height=".6"/></g>`,
  );
  return out.join("");
}

function terminalSvg(S) {
  const plan = { ...TERM };
  S.put(
    [TERM.x + TERM.w / 2, TERM.y, TERM_Z + TERM_H / 2],
    `<path class="iso-halo" d="${k.slabOf({ x: TERM.x + 4, y: TERM.y - 4, w: TERM.w - 8, d: 8, r: 3 }, 0, 0.1, P).fill}"/>` +
      D.uprightPanelSvg(plan, TERM_Z, TERM_H, P, { title: [12, 6], body: terminalBody }),
    -40,
  );
}

// ---------------------------------------------------------------------------------------------------------------
// The agent's copy, and its edits landing.

/** Token pills along a row, as one path per tone, at height z. */
function pillsAt(tokens, x, y, z) {
  const byTone = {};
  let at = x;
  for (const token of tokens) {
    (byTone[token.tone] ??= []).push(
      k.planOutline(
        { x: at, y: y - D.SHEET.pill / 2, w: token.len, d: D.SHEET.pill, r: D.SHEET.pill / 2 },
        z,
        P,
        2,
      ),
    );
    at += token.len + D.SHEET.gap;
  }
  return { byTone, end: at - D.SHEET.gap };
}

function copySvg(S, over) {
  const sheet = D.fileSheetSvg(COPY, 0, P, { code: COPY_CODE, seed: 5, glyph: "page" });
  const at = [COPY.x + SHEET_W / 2, COPY.y + sheet.d / 2, 0];
  S.put(at, sheet.svg);
  // The checkout's own label above its header: the branch glyph and the worktree's path.
  S.on(
    at,
    `<g transform="${D.faceTop(COPY.x + 22, COPY.y - 6.5, D.SHEET.h, P)}">${UI.box(0, 0, 42, 5, { tone: "hi", fill: "tint", r: 2.5 })}${UI.line(
      [
        [3, 1.2],
        [3, 3.8],
      ],
      "hi",
    )}${UI.dot(3, 1.2, 0.7, "hi")}${UI.dot(6, 2.4, 0.7, "hi")}${UI.line(
      [
        [3, 3],
        [6, 2.4],
      ],
      "hi",
    )}${UI.text(9, 2.5, [9, 18], "mid", 1.8)}</g>`,
    1,
  );
  const top = sheet.top;
  const gx = COPY.x + D.SHEET.gutter - 2;
  const band = (row) => ({
    x: gx + 0.8,
    y: sheet.rows[row].y - D.SHEET.pitch / 2 + 0.35,
    w: SHEET_W - D.SHEET.gutter + 0.6,
    d: D.SHEET.pitch - 0.7,
    r: 0.7,
  });
  const notch = (row, plus) => {
    const cy = sheet.rows[row].y;
    const nx = COPY.x + 7.6;
    return k.lineSvg(
      k.lineOnTop([nx - 1.3, cy], [nx + 1.3, cy], top, P) +
        (plus ? k.lineOnTop([nx, cy - 1.3], [nx, cy + 1.3], top, P) : ""),
      { tone: "hi", free: true },
    );
  };
  const xOf = (line) => COPY.x + D.SHEET.gutter + 1.2 + line.indent * D.SHEET.indent;
  const ends = [];
  EDITS.forEach((edit, i) => {
    const line = { ...NEW_LINES[i], indent: COPY_CODE[Math.max(0, edit.writes - 1)].indent };
    const cy = sheet.rows[edit.writes].y;
    const out = [];
    if (edit.removes >= 0) {
      // The line it replaces: sunk, hollow and struck, as a diff shows a removed line.
      const old = COPY_CODE[edit.removes];
      const oy = sheet.rows[edit.removes].y;
      const pills = pillsAt(old.tokens, xOf(old), oy, top);
      out.push(
        `<path class="dg-sunk" d="${k.planOutline(band(edit.removes), top, P, 2)}"/>`,
        `<path class="dg-hollow" d="${Object.values(pills.byTone).flat().join("")}"/>`,
        // The strike is a mark on the text, not a texture line.
        `<path class="dg-stroke" data-tone="mid" d="${k.lineOnTop([xOf(old) - 0.6, oy], [pills.end + 0.6, oy], top, P)}"/>`,
        notch(edit.removes, false),
      );
    }
    // The line it writes: raised, as a diff shows an added line.
    const raised = k.solidSvg(k.slabOf(band(edit.writes), top, D.SHEET.rise, P, 2), {
      tone: "mid",
      crease: "none",
      className: "dg-added",
    });
    const pills = pillsAt(line.tokens, xOf(line), cy, top + D.SHEET.rise);
    out.push(
      raised,
      Object.entries(pills.byTone)
        .map(
          ([tone, list]) =>
            `<path class="dg-pill" data-tone="${{ mid: "hi", lo: "mid", faint: "lo" }[tone] ?? tone}" d="${list.join("")}"/>`,
        )
        .join(""),
      notch(edit.writes, true),
    );
    S.on(at, hidden(`edit-${i}`, out.join("")), 2 + i);
    // While the agent writes it: the new line's pills appear one by one, rose, on the blank line.
    const typing = [];
    let tx = xOf(line);
    line.tokens.forEach((token, j) => {
      typing.push(
        `<path class="dg-pill" data-tone="lit" data-part="type-${i}-${j}" d="${k.planOutline({ x: tx, y: cy - D.SHEET.pill / 2, w: token.len, d: D.SHEET.pill, r: D.SHEET.pill / 2 }, top, P, 2)}"/>`,
      );
      tx += token.len + D.SHEET.gap;
    });
    typing.push(`<path class="dg-select" d="${k.planOutline(band(edit.writes), top, P, 2)}"/>`);
    S.on(at, hidden(`editing-${i}`, typing.join("")), 4 + i);
    ends.push([xOf(line) - 1, cy, top]);
  });
  // The agent reaching the line it writes: a rose line from its terminal, shown while it edits.
  ends.forEach((to, i) => {
    const from = [TERM.x + TERM.w - 14 + i * 6, TERM.y + TERM.d, TERM_Z];
    over.put(
      [1, 0, i],
      hidden(`reach-${i}`, D.connectorSvg(from, to, P, { tone: "lit", sag: 0.04 })),
    );
  });
  return sheet;
}

// ---------------------------------------------------------------------------------------------------------------
// The Fixes card.

const BAR = 6.4;
const PUSH_BTN = { u: 3, v: 63, w: 17, d: 6.6 };

const status = {
  queued: UI.text(0, 0, [10], "lo", 1.8),
  working: UI.pending(1.6, 0, 1.6) + UI.text(4.6, 0, [10], "mid", 1.8),
  ready: UI.text(0, 0, [8, 10], "hi", 1.8),
  pushing: UI.pending(1.6, 0, 1.6) + UI.text(4.6, 0, [11], "mid", 1.8),
  pushed: UI.check(1.6, 0, 2.6, "hi") + UI.text(4.6, 0, [9], "hi", 1.8),
};

function cardBody(w) {
  const out = [];
  // The turn's header: its title, its state, and when it started.
  out.push(UI.text(4, 4, [6, 7, 15], "hi", 2.6));
  out.push(
    Object.entries(status)
      .map(([name, svg]) => hidden(`status-${name}`, `<g transform="translate(40 4)">${svg}</g>`))
      .join(""),
  );
  out.push(UI.text(w - 14, 4, [10], "faint", 1.7));
  // What the agent did about each comment.
  THREADS.forEach((thread, i) => {
    const y = 8.6 + i * 13;
    out.push(UI.box(3, y, w - 6, 11.6, { tone: "faint", r: 1.4 }));
    out.push(hidden(`report-wait-${i}`, UI.text(6, y + 3.4, [18], "faint", 1.8)));
    out.push(
      hidden(
        `report-done-${i}`,
        UI.check(7.4, y + 3.4, 2.8, "hi") + UI.text(10.4, y + 3.4, [8], "mid", 2),
      ),
    );
    out.push(UI.text(27, y + 3.4, [5, 15], "lo", 1.8), UI.text(50, y + 3.4, [7], "lo", 1.8));
    out.push(UI.emblem(thread.emblem, w - 8.4, y + 3.4, 1.5, "mid"));
    out.push(
      hidden(
        `report-note-${i}`,
        UI.text(6, y + 8.2, i ? [14, 22, 9, 16] : [20, 11, 16, 7, 12], "lo", 1.6),
      ),
    );
  });
  // "prkit committed abc1234: ..."
  out.push(
    hidden(
      "commit-line",
      UI.text(4, 37.2, [7, 12], "lo", 1.8) +
        UI.text(27.2, 37.2, [10], "mid", 1.8) +
        UI.text(39.6, 37.2, [6, 15, 10], "lo", 1.8),
    ),
  );
  // The branch: the base line, the PR's commits forking off it, and the new commit prkit made on top. The dashed
  // ring is where GitHub's copy of the branch is.
  const { y, head, nodes, fresh, base } = GRAPH;
  out.push(`<rect class="dg-tint" x="3" y="${y - 4.4}" width="${w - 6}" height="15.4" rx="1.4"/>`);
  out.push(
    UI.line(
      [
        [5, y],
        [fresh + 6, y],
      ],
      "mid",
      false,
      true,
    ),
    UI.line(
      [
        [base[1], y],
        [base[1] + 5, head],
        [fresh, head],
      ],
      "hi",
      false,
      true,
    ),
  );
  base.forEach((x) => out.push(UI.dot(x, y, 1.8, "mid")));
  const node = (x) =>
    `<circle class="dg-paper" cx="${x}" cy="${head}" r="2.4"/>` +
    UI.ring(x, head, 2.4, "hi", false, true) +
    UI.dot(x, head, 1.1, "hi");
  nodes.forEach((x) => out.push(node(x) + UI.text(x + 3.6, head - 3.6, [7], "lo", 1.4)));
  out.push(hidden("fresh", node(fresh) + UI.text(fresh + 3.6, head - 3.6, [9], "mid", 1.4)));
  out.push(`<g data-part="remote"${attrsOf("remote")}>${UI.ring(0, 0, 4, "lo", true)}</g>`);
  // How far the branch is ahead of GitHub's: ↑1 until you push, then up to date.
  const chip = { x: w - 30, y: head - 3.4, w: 26, h: 6.8 };
  out.push(UI.box(chip.x, chip.y, chip.w, chip.h, { tone: "mid", fill: "paper", r: 3.4 }));
  out.push(
    hidden(
      "ahead",
      UI.arrowUp(chip.x + 5, head, 2, "hi") +
        UI.pill(chip.x + 8.6, head - 1, 2.2, 2, "hi") +
        UI.text(chip.x + 12.4, head, [10], "lo", 1.6),
    ),
  );
  out.push(
    hidden(
      "synced",
      UI.check(chip.x + 5, head, 3, "hi") + UI.text(chip.x + 9.4, head, [13], "mid", 1.6),
    ),
  );
  // The actions: Push (its own solid, drawn apart), Ask the agent to change, Copy patch, Discard.
  const by = PUSH_BTN.v + PUSH_BTN.d / 2;
  out.push(
    UI.box(23, PUSH_BTN.v, 40, PUSH_BTN.d, { tone: "hi", r: 1.2 }) +
      UI.text(27, by, [6, 5, 7, 10], "mid", 1.8),
    UI.text(68, by, [7, 8], "mid", 1.8),
    UI.text(w - 16, by, [12], "lo", 1.8),
    UI.line(
      [
        [3, PUSH_BTN.v - 2.6],
        [w - 3, PUSH_BTN.v - 2.6],
      ],
      "faint",
    ),
  );
  return out.join("");
}

/** Push, as a raised primary button on the card, and its hit area for a click. */
function pushSvg() {
  const plan = {
    x: CARD.x + PUSH_BTN.u,
    y: CARD.y + BAR + PUSH_BTN.v,
    w: PUSH_BTN.w,
    d: PUSH_BTN.d,
    r: 1.2,
  };
  const z = PANEL_H;
  const slab = k.slabOf(plan, z, 1, P, 3, 0.3);
  const label = `<g transform="${D.faceTop(plan.x, plan.y, z + 1, P)}"><rect class="fc-on-primary" x="3.4" y="${n1(plan.d / 2 - 0.85)}" width="${n1(plan.w - 6.8)}" height="1.7" rx=".85"/></g>`;
  return (
    `<g data-part="push"${attrsOf("push")}><g data-part="push-key">${k.solidSvg(slab, { tone: "hi", crease: "faint", className: "fc-primary" })}${label}</g></g>` +
    `<path class="fc-hit" data-part="push-hit" d="${slab.fill}"/>`
  );
}

/** Where the Push button is, as a world point, for the token's line. */
export const PUSH_AT = [CARD.x + PUSH_BTN.u, CARD.y + BAR + PUSH_BTN.v + PUSH_BTN.d / 2, PANEL_H];

// ---------------------------------------------------------------------------------------------------------------
// The two environments.

const ENV = [
  [4, 12],
  [4, 7],
  [4, 16],
  [5, 9],
  [4, 7],
  [6, 13],
  [4, 9],
];

function keysBody(w) {
  const out = [];
  const half = w / 2;
  // The agent's environment: an allowlist of plain variables, and no token among them.
  out.push(UI.chevron(5, 3.6, 1.2, "right", "hi"), UI.text(8.4, 3.6, [10], "hi", 2.2));
  ENV.forEach(([name, value], i) => {
    const cy = 9 + i * 3.8;
    out.push(UI.text(4, cy, [name], "mid", 1.5), UI.text(5.6 + name, cy, [value], "faint", 1.5));
  });
  const cy = 9 + ENV.length * 3.8 + 0.4;
  out.push(
    UI.key(4, cy - 1.7, 3.4, "lo"),
    UI.line(
      [
        [10, cy - 0.7],
        [24, cy - 0.7],
      ],
      "faint",
      true,
    ),
    UI.cross(27, cy - 0.7, 1.7, "hi"),
  );
  out.push(
    UI.line(
      [
        [half, 1.6],
        [half, 40],
      ],
      "faint",
    ),
  );
  // prkit's process: each account's token, held in memory.
  const x = half + 3;
  out.push(
    `<rect class="dg-pill" data-tone="hi" x="${x + 1}" y="2" width="3.2" height="3.2" rx=".6"/>`,
    UI.text(x + 6.4, 3.6, [10], "hi", 2.2),
  );
  out.push(`<rect class="dg-tint" x="${x}" y="7.6" width="${n1(half - 6)}" height="10" rx="1.2"/>`);
  out.push(
    UI.key(x + 2, 9.6, 5, "hi"),
    UI.text(x + 11, 10.8, [12], "hi", 2),
    UI.passed(w - 7, 12.6, 2.2),
  );
  out.push(UI.text(x + 11, 14.6, [7, 10], "lo", 1.5));
  ["circle", "square", "triangle"].forEach((emblem, i) => {
    const ey = 22.4 + i * 4.8;
    out.push(
      UI.emblem(emblem, x + 2.6, ey, 1.4, "mid"),
      UI.text(x + 6, ey, [9 + i * 2, 6], "lo", 1.6),
    );
  });
  return out.join("");
}

/** Where the token's row is, as a world point. */
export const TOKEN_AT = [KEYS.x + KEYS.w - 7, KEYS.y + BAR + 12.6, PANEL_H];

// ---------------------------------------------------------------------------------------------------------------

export function drawing() {
  const S = D.sceneOf(P);
  const over = D.sceneOf(P);
  terminalSvg(S);
  diffSvg(S, over);
  copySvg(S, over);
  S.put(
    [CARD.x + CARD.w / 2, CARD.y + CARD.d / 2, 0],
    `<g data-part="card">${D.flatPanelSvg(CARD, 0, P, { title: [10, 8], body: cardBody })}</g>` +
      pushSvg(),
  );
  S.put(
    [KEYS.x + KEYS.w / 2, KEYS.y + KEYS.d / 2, 0],
    D.flatPanelSvg(KEYS, 0, P, { title: [14, 6], body: keysBody }),
  );
  // The commit: from the agent's copy to the new commit on the card's branch.
  const fresh = [CARD.x + GRAPH.fresh, CARD.y + BAR + GRAPH.head, PANEL_H];
  over.put(
    [2, 0, 0],
    hidden(
      "commit-link",
      D.connectorSvg([COPY.x + 30, COPY.y + 76, D.SHEET.h], fresh, P, { tone: "mid", sag: 0.03 }),
    ),
  );
  // prkit's token reaches only Push: a dashed line, and on push a dash running along it.
  const tokenPath = D.threadPath(TOKEN_AT, PUSH_AT, P, 0.02);
  over.put(
    [3, 0, 0],
    k.lineSvg(tokenPath, { tone: "lo", dashed: true }) +
      k.dotsSvg([k.iso(TOKEN_AT, P), k.iso(PUSH_AT, P)], { size: 0.9, tone: "hi" }) +
      `<path class="iso-line fc-pulse" data-tone="hi" data-part="token-pulse" pathLength="2" opacity="0" d="${tokenPath}"/>`,
  );
  return D.slimSvg(S.body() + over.body());
}
