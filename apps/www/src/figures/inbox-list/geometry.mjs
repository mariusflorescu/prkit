// The inbox list's drawing, built once at build time with the kit and prkit's digital materials. Everything is
// drawn the way the app shows it: the prkit window with its tab strip, the Inbox header and toolbar (search, the
// account select, the repository select), then the three groups as cards, each a header with its count and its
// rows. The account select's popup floats over the list. live.js moves the parts named with data-part and
// data-row; nothing here is rebuilt on the page except the group cards' outlines (cardPaths).
import * as k from "../kit/iso-kit.mjs";
import * as D from "../kit/prkit-digital.mjs";
import { ACCOUNTS, GROUPS, MEMBERS, PULLS, targetsOf } from "./model.mjs";
import {
  CARD,
  CARD_H,
  P,
  PITCH,
  POPUP,
  POPUP_ROW,
  POPUP_Z,
  SELECT,
  WIN,
  WIN_H,
  cardPaths,
  layoutOf,
} from "./view.mjs";

const { UI } = D;
const TOP = WIN_H + CARD_H;
/** A row's tile stands this proud of its card. */
const ROW_H = 0.5;
const n1 = (value) => Math.round(value * 100) / 100;

/** A solid drawn with every path it can need, so the page only rewrites their `d`. */
const liveSolidSvg = (paths, part) =>
  `<g class="iso-solid" data-part="${part}"><path class="iso-halo" d="${paths.fill}"/><path class="iso-fill" d="${paths.fill}"/>${[0, 1, 2, 3].map((shade) => `<path class="iso-shade" data-shade="${shade}" d="${paths.shades[shade]}"/>`).join("")}<path class="iso-top" d="${paths.top}"/><path class="iso-line iso-crease" data-tone="faint" d="${paths.crease}"/><path class="iso-line iso-bevel" data-tone="faint" d="${paths.bevel ?? ""}"/><path class="iso-line iso-edge" data-tone="hi" d="${paths.outline}"/></g>`;

// ---------------------------------------------------------------------------------------------------------------
// Icons the app draws (lucide's), as flat strokes in a face's own units.

const icon = {
  /** git-pull-request: two commits on a branch and the PR's arrow back into it. */
  pull: (x, y, s, tone = "mid") =>
    UI.ring(x, y, s * 0.28, tone) +
    UI.ring(x, y + s * 1.6, s * 0.28, tone) +
    UI.line(
      [
        [x, y + s * 0.28],
        [x, y + s * 1.32],
      ],
      tone,
    ) +
    UI.ring(x + s * 1.3, y + s * 1.6, s * 0.28, tone) +
    UI.line(
      [
        [x + s * 1.3, y + s * 1.32],
        [x + s * 1.3, y + s * 0.5],
        [x + s * 1.0, y + s * 0.2],
        [x + s * 0.55, y + s * 0.2],
      ],
      tone,
    ),
  search: (x, y, s, tone = "mid") =>
    UI.ring(x, y, s * 0.42, tone) +
    UI.line(
      [
        [x + s * 0.32, y + s * 0.32],
        [x + s * 0.7, y + s * 0.7],
      ],
      tone,
    ),
  /** book-open-text, the guide mark. */
  book: (x, y, s, tone = "mid") =>
    UI.line(
      [
        [x, y - s * 0.35],
        [x - s * 0.45, y - s * 0.5],
        [x - s * 0.9, y - s * 0.35],
        [x - s * 0.9, y + s * 0.45],
        [x - s * 0.45, y + s * 0.3],
        [x, y + s * 0.45],
        [x + s * 0.45, y + s * 0.3],
        [x + s * 0.9, y + s * 0.45],
        [x + s * 0.9, y - s * 0.35],
        [x + s * 0.45, y - s * 0.5],
        [x, y - s * 0.35],
        [x, y + s * 0.45],
      ],
      tone,
    ),
  /** layers, the stack mark. */
  layers: (x, y, s, tone = "mid") =>
    [-0.35, 0, 0.35]
      .map((dy, i) =>
        UI.line(
          i === 0
            ? [
                [x - s * 0.8, y + dy * s],
                [x, y + (dy - 0.32) * s],
                [x + s * 0.8, y + dy * s],
                [x, y + (dy + 0.32) * s],
                [x - s * 0.8, y + dy * s],
              ]
            : [
                [x - s * 0.8, y + dy * s],
                [x, y + (dy + 0.32) * s],
                [x + s * 0.8, y + dy * s],
              ],
          tone,
        ),
      )
      .join(""),
  refresh: (x, y, s, tone = "mid") =>
    `<path class="dg-stroke" data-tone="${tone}" d="M${n1(x + s * 0.5)} ${n1(y - s * 0.3)}A${n1(s * 0.55)} ${n1(s * 0.55)} 0 1 0 ${n1(x + s * 0.5)} ${n1(y + s * 0.3)}"/>` +
    UI.line(
      [
        [x + s * 0.5, y - s * 0.75],
        [x + s * 0.5, y - s * 0.3],
        [x + s * 0.08, y - s * 0.3],
      ],
      tone,
    ),
  inbox: (x, y, s, tone = "mid") =>
    UI.line(
      [
        [x - s * 0.8, y],
        [x - s * 0.55, y - s * 0.6],
        [x + s * 0.55, y - s * 0.6],
        [x + s * 0.8, y],
        [x + s * 0.8, y + s * 0.55],
        [x - s * 0.8, y + s * 0.55],
        [x - s * 0.8, y],
        [x - s * 0.3, y],
        [x - s * 0.15, y + s * 0.22],
        [x + s * 0.15, y + s * 0.22],
        [x + s * 0.3, y],
        [x + s * 0.8, y],
      ],
      tone,
    ),
};

/** "All accounts": the three emblems side by side. */
const allMark = (x, y, r) =>
  ACCOUNTS.map((account, i) => UI.emblem(account.emblem, x + i * r * 2.5, y, r, "mid")).join("");

/** The +n -n counts as the row's right edge shows them, as pills sized by their digits. */
const digits = (count) => String(count).length;

// ---------------------------------------------------------------------------------------------------------------
// The window, header and toolbar.

function chromeSvg() {
  const out = [];
  // The title bar: window dots, the Inbox tab (the fixed first one), then open PRs as compact tabs, then "+".
  out.push(
    `<rect class="dg-bar" x="0.6" y="0.6" width="${WIN.w - 1.2}" height="5.8" rx="1.6"/>`,
    [0, 1, 2].map((i) => UI.ring(3.4 + i * 2.6, 3.5, 0.8, "mid")).join(""),
    UI.text(12.4, 3.5, [6], "hi", 1.6),
    UI.box(21, 1.3, 17, 4.4, { tone: "mid", r: 1.2 }),
    icon.inbox(24, 3.5, 1.6, "hi"),
    UI.text(26.6, 3.5, [8.6], "hi", 1.5),
    UI.line(
      [
        [40.4, 1.9],
        [40.4, 5.1],
      ],
      "faint",
    ),
    [0, 1, 2, 3]
      .map(
        (i) =>
          icon.pull(43.4 + i * 11, 2.1, 1.6, "mid") +
          UI.text(46.2 + i * 11, 3.5, [4 + (i % 2) * 1.6], "mid", 1.4),
      )
      .join(""),
    UI.line(
      [
        [88.6, 3.5],
        [91.4, 3.5],
      ],
      "mid",
    ) +
      UI.line(
        [
          [90, 2.1],
          [90, 4.9],
        ],
        "mid",
      ),
  );
  // The Inbox header: its title, when it was updated, and Refresh.
  out.push(
    UI.text(5, 11, [13], "hi", 2.6),
    UI.text(WIN.w - 52, 11, [9, 2, 8, 5], "faint", 1.7),
    icon.refresh(WIN.w - 18.6, 11, 2.4, "hi"),
    UI.text(WIN.w - 15.6, 11, [10.6], "mid", 2),
    UI.line(
      [
        [0.6, 14.6],
        [WIN.w - 0.6, 14.6],
      ],
      "faint",
    ),
    UI.line(
      [
        [0.6, 26],
        [WIN.w - 0.6, 26],
      ],
      "faint",
    ),
  );
  // A scrollbar along the right edge, the list near its top.
  out.push(
    `<rect class="dg-tint" x="${WIN.w - 2.6}" y="28" width="1.4" height="${WIN.d - 31}" rx=".7"/>`,
    UI.pill(WIN.w - 2.6, 28.4, 1.4, 52, "faint"),
  );
  return out.join("");
}

/** A control in the toolbar: a raised field with its content on top. */
function fieldSvg(plan, body, part = "") {
  const z = WIN_H;
  const solid = k.solidSvg(k.slabOf(plan, z, 0.7, P, 3, 0.3), { tone: "mid", crease: "faint" });
  return `<g${part ? ` data-part="${part}"` : ""}>${solid}<g transform="${D.faceTop(plan.x, plan.y, z + 0.7, P)}">${body}</g></g>`;
}

function toolbarSvg() {
  const search = { x: 5, y: SELECT.y, w: SELECT.x - 8, d: SELECT.d, r: 2 };
  const repo = {
    x: SELECT.x + SELECT.w + 3,
    y: SELECT.y,
    w: WIN.w - 5 - (SELECT.x + SELECT.w + 3),
    d: SELECT.d,
    r: 2,
  };
  const mid = SELECT.d / 2;
  // The account select shows its value: All accounts, or the account's emblem and login. All four are drawn;
  // live.js shows the one picked.
  const trigger = [
    allMark(4, mid, 1.1) + UI.text(11.6, mid, [13], "hi", 1.8),
    ...ACCOUNTS.map(
      (account, i) =>
        UI.emblem(account.emblem, 4.6, mid, 1.6, "hi") + UI.text(8.6, mid, [7 + i * 2], "hi", 1.8),
    ),
  ]
    .map((svg, i) => `<g data-part="trigger-${i}"${i ? ' opacity="0"' : ""}>${svg}</g>`)
    .join("");
  return (
    fieldSvg(
      search,
      icon.search(4.4, mid - 0.2, 3, "mid") + UI.text(8.4, mid, [9, 12, 7, 11], "faint", 1.6),
    ) +
    fieldSvg(SELECT, trigger + UI.chevron(SELECT.w - 4, mid, 1, "down", "mid"), "select") +
    fieldSvg(
      repo,
      UI.text(3.4, mid, [4, 9], "hi", 1.8) + UI.chevron(repo.w - 4, mid, 1, "down", "mid"),
    )
  );
}

// ---------------------------------------------------------------------------------------------------------------
// The list.

const TITLE_LENS = [[11, 6, 9], [10], [13]];

/** A group's header on its card: the title, the count as pips in a badge, and the rule after it. */
function headerSvg(group, y) {
  const lens = TITLE_LENS[group];
  const width = lens.reduce((sum, len) => sum + len + 1.4, 0);
  const count = MEMBERS[group].length;
  const bx = 4 + width + 1.6;
  const bw = 2.2 + count * 2.1;
  const pips = MEMBERS[group]
    .map(
      (_, i) =>
        `<circle class="dg-pill" data-tone="hi" data-part="pip-${group}-${i}" cx="${n1(bx + 2.1 + i * 2.1)}" cy="4.6" r=".62"/>`,
    )
    .join("");
  return `<g data-part="head-${group}"><g transform="${D.faceTop(CARD.x, y, TOP, P)}">${UI.text(4, 4.6, lens, "hi", 2.4)}${UI.box(bx, 3, bw, 3.2, { tone: "", fill: "tint", r: 1.6 })}${pips}${UI.line(
    [
      [bx + bw + 3, 4.6],
      [CARD.w - 4, 4.6],
    ],
    "faint",
  )}</g></g>`;
}

/** A title as word pills, long enough to fill the row the way a real title does, short of the counts. */
const titleLens = (index, room) => {
  const random = D.seeded(17 + index * 13);
  const lens = [];
  let used = 0;
  for (;;) {
    const len = 4 + random() * 9;
    if (used + len > room) break;
    lens.push(len);
    used += len + 1.4;
  }
  return lens;
};

/** One row as the app draws it, at its place in the full list. */
function rowSvg(index, y) {
  const pull = PULLS[index];
  const account = ACCOUNTS[pull.account];
  const c1 = 3.6;
  const c2 = 7.2;
  const out = [];
  // The state icon, and the checks dot under it when there are checks. The app tells passing from pending by color
  // (InboxRow.tsx); in the figure's one ink, a pending run is drawn as a ring instead.
  out.push(icon.pull(4.6, c1 - 1.6, 1.9, "hi"));
  if (pull.checks === "pass") out.push(UI.dot(5.8, c2 + 0.4, 0.75, "mid"));
  if (pull.checks === "pending") out.push(UI.ring(5.8, c2 + 0.4, 0.7, "mid"));
  // Line 1: #number, the title, then its mark.
  out.push(UI.text(10.6, c1, [4.6], "mid", 1.8));
  const room = (pull.mark ? 44 : 62) - (index % 3) * 6;
  const lens = titleLens(index, room);
  out.push(UI.text(16.6, c1, lens, "hi", 2.2));
  let x = 16.6 + lens.reduce((sum, len) => sum + len + 1.4, 0) + 1.6;
  let cursor = "";
  if (pull.mark === "writing" || pull.mark === "ready") {
    // The mark is muted in the app (InboxGuideMark.tsx), so only the agent's cursor beside it carries rose.
    out.push(
      icon.book(x + 1, c1, 2, "mid"),
      UI.text(x + 3.6, c1, [pull.mark === "writing" ? 11 : 10], "mid", 1.6),
    );
    x += 3.6 + 11 + 1;
    if (pull.mark === "writing") cursor = cursorSvg(CARD.x + x + 0.8, y + c1);
  }
  if (pull.mark === "stack") {
    out.push(icon.layers(x + 1, c1, 1.8, "mid"), UI.text(x + 3.2, c1, [6], "mid", 1.6));
    // "Stack n/3" as pips: the layer, filled, out of three.
    out.push(
      [0, 1, 2]
        .map((i) =>
          i < pull.layer
            ? UI.dot(x + 10.8 + i * 1.7, c1, 0.5, "hi")
            : UI.ring(x + 10.8 + i * 1.7, c1, 0.45, "lo"),
        )
        .join(""),
    );
  }
  // Line 2: the author's avatar and login, the repository, then the account that found it.
  out.push(
    `<circle class="dg-tint" cx="11.6" cy="${c2}" r="1.3"/>`,
    UI.ring(11.6, c2, 1.3, "lo"),
    UI.dot(11.6, c2 - 0.3, 0.45, "lo"),
    UI.text(14.2, c2, [7 + (index % 3) * 1.4], "lo", 1.6),
    UI.text(14.2 + 8.6 + (index % 3) * 1.4, c2, [6, 9], "lo", 1.6),
  );
  const ax = 14.2 + 8.6 + (index % 3) * 1.4 + 18.2;
  out.push(
    UI.emblem(account.emblem, ax + 1.6, c2, 1.8, "hi"),
    UI.text(ax + 3.8, c2, [5 + pull.account * 1.6], "faint", 1.4),
  );
  // The right edge: +additions -deletions, and when it was updated.
  const minus = 2.2 + digits(pull.removed) * 1.4;
  const plus = 2.2 + digits(pull.added) * 1.4;
  out.push(
    UI.pill(CARD.w - 4 - minus, c1 - 0.85, minus, 1.7, "lo"),
    UI.pill(CARD.w - 5.4 - minus - plus, c1 - 0.85, plus, 1.7, "mid"),
    UI.pill(CARD.w - 4 - 9 - (index % 2) * 3, c2 - 0.75, 9 + (index % 2) * 3, 1.5, "faint"),
  );
  // Each row is a list item: a low tile, so a long title still reads as one row along the slope.
  const tile = k.solidSvg(
    k.slabOf(
      { x: CARD.x + 1.6, y: y + 0.5, w: CARD.w - 3.2, d: PITCH - 1, r: 1.4 },
      TOP,
      ROW_H,
      P,
      3,
    ),
    {
      tone: "lo",
      crease: "faint",
    },
  );
  return `<g data-row="${index}" data-account="${pull.account}">${tile}<g transform="${D.faceTop(CARD.x, y, TOP + ROW_H, P)}">${out.join("")}</g>${cursor}</g>`;
}

/** The agent, writing this pull request's first guide: a terminal's block cursor, stood on the row after the mark. */
function cursorSvg(x, y) {
  const block = k.slabOf({ x, y: y - 0.8, w: 1.7, d: 1.6, r: 0.2 }, TOP + ROW_H, 3, P, 1);
  const shades = block.shades
    .map((d, i) => (d ? `<path class="dg-face" data-light="${i}" d="${d}"/>` : ""))
    .join("");
  return `<g class="dg-gem" data-part="cursor"><path class="iso-fill" d="${block.fill}"/>${shades}<path class="dg-face" data-light="1" d="${block.top}"/><path class="dg-gem-edge" d="${block.outline}"/></g>`;
}

// ---------------------------------------------------------------------------------------------------------------
// The account select's popup.

function popupSvg() {
  const body = [];
  body.push(
    `<rect class="dg-tint" data-part="popup-hover" x="1.4" y="1.6" width="${POPUP.w - 2.8}" height="${POPUP_ROW - 0.6}" rx="1"/>`,
  );
  const items = [
    allMark(5, 0, 1.1) + UI.text(12.6, 0, [17], "hi", 1.8),
    ...ACCOUNTS.map(
      (account, i) =>
        UI.emblem(account.emblem, 5.6, 0, 1.6, "hi") + UI.text(9.6, 0, [8 + i * 2], "hi", 1.8),
    ),
  ];
  items.forEach((svg, i) => {
    const cy = 4.8 + i * POPUP_ROW;
    body.push(
      `<g transform="translate(0 ${n1(cy)})">${svg}</g>`,
      `<g data-part="popup-check-${i}"${i ? ' opacity="0"' : ""}>${UI.check(POPUP.w - 5, cy, 2.6, "hi")}</g>`,
    );
  });
  const plan = { ...POPUP };
  const solid = k.solidSvg(k.slabOf(plan, POPUP_Z, 1.2, P, 3, 0.4), {
    tone: "hi",
    crease: "faint",
  });
  const halo = `<g data-part="popup-shadow" opacity="0"><path class="iso-halo" d="${k.slabOf({ x: plan.x + 2, y: plan.y + 2, w: plan.w - 2, d: plan.d - 1, r: 3 }, WIN_H + CARD_H, 0.1, P).fill}"/></g>`;
  return {
    shadow: halo,
    popup: `<g data-part="popup" opacity="0">${solid}<g transform="${D.faceTop(plan.x, plan.y, POPUP_Z + 1.2, P)}">${body.join("")}</g></g>`,
  };
}

// ---------------------------------------------------------------------------------------------------------------

/** The whole drawing, at rest on All accounts. */
export function drawing() {
  const rest = targetsOf(null);
  const { cards, rows } = layoutOf(rest.rows, rest.groups);
  const out = [];
  out.push(D.flatPanelSvg(WIN, 0, P, { h: WIN_H, bar: 0, body: chromeSvg }));
  out.push(toolbarSvg());
  GROUPS.forEach((_, group) => {
    out.push(
      `<g data-group="${group}">`,
      liveSolidSvg(cardPaths(cards[group]), `card-${group}`),
      headerSvg(group, cards[group].y),
    );
    for (const index of MEMBERS[group]) out.push(rowSvg(index, rows[index]));
    out.push(`</g>`);
  });
  const { shadow, popup } = popupSvg();
  out.push(shadow, popup);
  return D.slimSvg(out.join(""));
}
