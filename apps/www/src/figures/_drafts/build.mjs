/**
 * Rough concept stills for Figures 2 to 5, in the digital vocabulary of kit/prkit-digital.mjs: every part is drawn
 * the way software shows it. Dev pages only, not shipped on the site.
 *
 *   node apps/www/src/figures/_drafts/build.mjs   ->   apps/www/.figures/draft-fig2.html ... draft-fig5.html
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import * as k from "../kit/iso-kit.mjs";
import * as D from "../kit/prkit-digital.mjs";

const WWW = fileURLToPath(new URL("../../../", import.meta.url));
const OUT = join(WWW, ".figures");
const W = 640;
const H = 480;
const { UI } = D;

const fit = (points, azimuth = 45) => k.fitProjection(points, W, H, { pad: 26, azimuth });
const halo = (plan, P) => `<path class="iso-halo" d="${k.slabOf(plan, 0, 0.1, P).fill}"/>`;

// ---------------------------------------------------------------------------------------------------------------
// Fig 2: the inbox as list UI. Three account chips filter it; the square account is active, so every group
// narrows to its rows and the others' rows fade out. Each row carries the emblem of the account that found it.

function fig2() {
  const WIN = { x: 0, y: 0, w: 170, d: 176, r: 3 };
  // Turned to 60 degrees so the list rows run nearly level and read as rows.
  const P = fit([...k.boxCorners(WIN, 0, 12)], 60);
  const S = D.sceneOf(P);
  const accounts = ["circle", "square", "triangle"];
  const active = "square";
  const groups = [
    { rows: ["square", "circle", "square", "triangle"], icon: "pending" },
    { rows: ["circle", "square", "triangle"], icon: "pass" },
    { rows: ["triangle", "square", "circle"], icon: "comment" },
  ];
  const at = [85, 88, 0];
  S.put(at, D.flatPanelSvg(WIN, 0, P, { h: 2, title: [16, 8], body: () => "" }));
  const top = 2;
  // The filter bar: one raised chip per account, the active one filled.
  accounts.forEach((emblem, i) => {
    const chip = { x: 6 + i * 30, y: 9.6, w: 26, d: 8, r: 4 };
    const on = emblem === active;
    S.on(
      at,
      k.solidSvg(k.slabOf(chip, top, on ? 1.6 : 0.8, P, 4, 0.3), {
        tone: on ? "hi" : "mid",
        crease: "faint",
      }) +
        `<g transform="${D.faceTop(chip.x, chip.y, top + (on ? 1.6 : 0.8), P)}">${UI.avatar(4.4, 4, 2.6, emblem, on ? "hi" : "mid")}${UI.text(8.8, 4, [12], on ? "hi" : "lo", 1.8)}</g>`,
      1,
    );
  });
  // Three grouped sections, in priority order: Needs your review, Yours, Involved. A PR shows once, in its highest.
  let y = 22;
  groups.forEach((group, g) => {
    const d = 9 + group.rows.length * 9;
    const card = { x: 5, y, w: 160, d, r: 2 };
    const rows = group.rows
      .map((emblem, i) => {
        const cy = 13 + i * 9;
        const shown = emblem === active;
        const icon =
          group.icon === "pending"
            ? UI.pending(146, cy, 2.2)
            : group.icon === "pass"
              ? UI.passed(146, cy, 2.2)
              : UI.comment(144, cy - 1.6, 3.4);
        return `<g${shown ? "" : ' opacity=".28"'}>${
          i
            ? UI.line(
                [
                  [3, cy - 4.5],
                  [157, cy - 4.5],
                ],
                "faint",
              )
            : ""
        }${UI.emblem(emblem, 6, cy, 2.2, "hi")}${UI.text(11, cy, [7], "mid", 2)}${UI.text(21, cy, [30 + ((i * 17 + g * 11) % 30), 14], shown ? "hi" : "lo", 2)}${icon}</g>`;
      })
      .join("");
    S.on(
      at,
      k.solidSvg(k.slabOf(card, top, 1, P, 3, 0.4), { tone: "hi", crease: "faint" }) +
        `<g transform="${D.faceTop(card.x, card.y, top + 1, P)}">${UI.chevron(5, 4.6, 1.4, "down")}${UI.text(9, 4.6, [18 + g * 4], "hi", 2.4)}${UI.dot(36 + g * 4, 4.6, 2, "mid")}${UI.line(
          [
            [2, 8.4],
            [158, 8.4],
          ],
          "faint",
        )}${rows}</g>`,
      2 + g,
    );
    y += d + 5;
  });
  return {
    P,
    body: S.body(),
    label:
      "The inbox as a list: three account filter chips, the square one active, and three grouped sections whose rows each carry the emblem of the account that found them.",
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Fig 3: fixes. Two selected review threads on a diff go as one batch to the agent's terminal session. The agent
// edits its own worktree copy, prkit makes one commit, and the local branch is ahead by one, not pushed. The token
// stays in prkit's own settings; the agent's environment list has no token row.

function fig3() {
  const code = D.codeOf(
    ["hunk", "ctx", "del", "add", "add", "ctx", "ctx", "hunk", "ctx", "add", "ctx", "ctx"],
    31,
  );
  const left = { x: 0, y: 0, w: 70 };
  const right = { x: 120, y: 0, w: 70 };
  const depth = D.sheetDepth(code.length);
  const TERM = { x: 58, y: -64, w: 74, d: 1.6 };
  const GRAPH = { x: 100, y: depth + 12, w: 96, d: 34, r: 2.4 };
  const KEYS = { x: -2, y: depth + 12, w: 80, d: 30, r: 2.4 };
  const P = fit([
    ...k.boxCorners({ ...left, d: depth, r: 0 }, 0, 2),
    ...k.boxCorners({ ...right, d: depth, r: 0 }, 0, 2),
    [TERM.x, TERM.y, 74],
    [TERM.x + TERM.w, TERM.y, 74],
    ...k.boxCorners(GRAPH, 0, 2),
    ...k.boxCorners(KEYS, 0, 2),
  ]);
  const S = D.sceneOf(P);
  const over = D.sceneOf(P);
  const a = D.fileSheetSvg(left, 0, P, { code, seed: 2, glyph: "page" });
  S.put([35, depth / 2, 0], a.svg);
  // The agent's own copy: the same file in its worktree, the lines it is editing lit.
  const b = D.fileSheetSvg(right, 0, P, { code, seed: 2, glyph: "page", lit: new Set([9]) });
  S.put([155, depth / 2, 0], b.svg);
  S.on(
    [155, depth / 2, 0],
    `<g transform="${D.faceTop(right.x + 26, -6.5, D.SHEET.h, P)}">${UI.box(0, 0, 40, 5, { tone: "hi", fill: "tint", r: 2.5 })}${UI.line(
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
    )}${UI.text(9, 2.5, [26], "mid", 1.8)}</g>`,
    1,
  );
  // Inline review threads on the diff, the two picked for this batch ticked.
  const threads = [
    { row: 3, selected: true, replies: 1, emblem: "circle" },
    { row: 9, selected: true, replies: 0, emblem: "square" },
  ];
  const ends = [];
  threads.forEach((t, i) => {
    const r = a.rows[t.row];
    const card = { x: 18, y: r.y + 2.6, w: 48, d: 8 + t.replies * 6, r: 1.2 };
    const ui = D.threadUi(0, 0, card.w, {
      replies: t.replies,
      emblem: t.emblem,
      selected: t.selected,
      seed: 7 + i,
    });
    S.on(
      [35, depth / 2, 0],
      k.solidSvg(k.slabOf(card, a.top, 0.8, P, 2, 0.3), {
        tone: "hi",
        crease: "faint",
        halo: true,
      }) + `<g transform="${D.faceTop(card.x, card.y, a.top + 0.8, P)}">${ui.svg}</g>`,
      2 + i,
    );
    ends.push([card.x + card.w - 3.4, card.y + 3.8, a.top + 0.8]);
  });
  // The agent's terminal session, behind, the batch arriving as one turn.
  S.put(
    [TERM.x + 37, TERM.y, 30],
    halo({ x: TERM.x + 4, y: TERM.y - 4, w: TERM.w - 8, d: 8, r: 3 }, P) +
      D.uprightPanelSvg(TERM, 30, 42, P, {
        title: [12],
        body: (w, h) => D.terminalUi(w, h, { lines: 5 }),
      }),
    -50,
  );
  ends.forEach((from, i) =>
    over.put(
      [0, 0, i],
      D.connectorSvg(from, [TERM.x + 14 + i * 8, TERM.y + 1.6, 31.6], P, {
        tone: "mid",
        sag: 0.05,
      }),
    ),
  );
  over.put(
    [0, 0, 9],
    D.connectorSvg(
      [TERM.x + TERM.w - 10, TERM.y + 1.6, 31.6],
      [right.x + 30, b.rows[9].y, b.top],
      P,
      { tone: "lit", sag: 0.05 },
    ),
  );
  // One commit, local: the branch is ahead by one and nothing has been pushed.
  S.put(
    [GRAPH.x + 48, GRAPH.y + 17, 0],
    D.flatPanelSvg(GRAPH, 0, P, {
      title: [10],
      body: (w, d) =>
        D.commitGraphUi(w - 30, d, { base: 1, head: 3, fresh: 2, remote: 1 }) +
        UI.box(w - 28, 4, 24, 6, { tone: "hi", fill: "tint", r: 3 }) +
        UI.arrowUp(w - 23, 7, 1.8) +
        UI.dot(w - 18, 7, 1, "hi") +
        UI.text(w - 15, 7, [8], "mid", 1.6) +
        UI.button(w - 28, 15, 24, 7),
    }),
  );
  // prkit's settings: the token lives in its row, with the key glyph. The agent's environment has no token row.
  S.put(
    [KEYS.x + 40, KEYS.y + 15, 0],
    D.flatPanelSvg(KEYS, 0, P, {
      title: [12],
      body: (w) =>
        UI.key(4, 3, 3.4) +
        UI.text(11, 4.2, [16, 10], "hi", 1.8) +
        UI.passed(w - 6, 4.2, 2) +
        UI.line(
          [
            [3, 9.4],
            [w - 3, 9.4],
          ],
          "faint",
        ) +
        [0, 1, 2].map((i) => UI.text(4, 13 + i * 3.8, [8, 12 + i * 3], "lo", 1.6)).join("") +
        UI.key(w - 18, 12.4, 2.4, "lo") +
        UI.cross(w - 15, 13.2, 2.6, "hi"),
    }),
  );
  return {
    P,
    body: S.body() + over.body(),
    label:
      "Fixes: two picked review threads go as one batch to the agent's terminal session, which edits its own worktree copy of the file. prkit makes one commit, the branch is ahead by one and not pushed, and the token stays in prkit's settings while the agent's environment has none.",
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Fig 4: a stack of three PRs, numbered from the bottom, each based on the one below. Each open layer has its own
// guide, whose connectors reach only that layer's diff. The agent works bottom to top: layer 1 done, 2 now, 3 next.

function fig4() {
  const layers = [0, 1, 2].map((i) => ({
    plan: { x: i * 22, y: i * -26, w: 104, d: 46, r: 2.4 },
    z: i * 30,
  }));
  const guides = layers.map(({ plan, z }) => ({
    plan: { x: plan.x + 112, y: plan.y - 4, w: 50, d: 1.6 },
    z: z + 8,
    h: 34,
  }));
  const P = fit([
    ...layers.flatMap(({ plan, z }) => k.boxCorners(plan, z, z + 2)),
    ...guides.flatMap(({ plan, z, h }) => k.boxCorners({ ...plan, r: 0 }, z, z + h)),
  ]);
  const S = D.sceneOf(P);
  const over = D.sceneOf(P);
  layers.forEach(({ plan, z }, i) => {
    const body = (w) =>
      // Its number, from the bottom, then base <- head: the base is the layer below's head.
      Array.from({ length: i + 1 }, (_, p) => UI.dot(5 + p * 3, 4, 1.1, "hi")).join("") +
      UI.box(16, 1.6, 22, 4.6, { tone: "lo", fill: "tint", r: 2.3 }) +
      UI.text(19, 3.9, [16], "lo", 1.6) +
      UI.line(
        [
          [48, 3.9],
          [40.4, 3.9],
        ],
        "hi",
      ) +
      UI.line(
        [
          [42.4, 2.3],
          [40.4, 3.9],
          [42.4, 5.5],
        ],
        "hi",
      ) +
      UI.box(50, 1.6, 26, 4.6, { tone: "hi", fill: "tint", r: 2.3 }) +
      UI.text(53, 3.9, [20], "mid", 1.6) +
      [0, 1, 2, 3, 4, 5]
        .map((r) => {
          const cy = 13 + r * 4;
          const add = r % 3 !== 2;
          return (
            `<rect class="${add ? "dg-tint" : "dg-sunk"}" x="3" y="${cy - 1.8}" width="${w - 6}" height="3.6" rx=".6"/>` +
            UI.text(5, cy, [2], "faint", 1.2) +
            UI.text(10, cy, [10 + ((r * 13) % 20), 8], add ? "mid" : "lo", 1.6)
          );
        })
        .join("");
    S.put(
      [plan.x + 52, plan.y + 23, z],
      (i === 0 ? halo(plan, P) : "") + D.flatPanelSvg(plan, z, P, { title: [14, 6], body }),
      i * 100,
    );
    if (i > 0) {
      // The base chip points at the head of the layer below: a dashed connector between them.
      const below = layers[i - 1];
      over.put(
        [0, 0, i],
        k.lineSvg(
          k.pathOf([
            k.iso([plan.x + 27, plan.y + 6.4 + 3.9, z + 1.6], P),
            k.iso([below.plan.x + 63, below.plan.y + 6.4 + 3.9, below.z + 1.6], P),
          ]),
          { tone: "lo", dashed: true },
        ),
      );
    }
    const g = guides[i];
    const state = i === 0 ? "done" : i === 1 ? "writing" : "waiting";
    const p = D.guidePanelSvg(g.plan, g.z, g.h, P, {
      kind: "chapter",
      number: 1,
      revision: 1,
      lit: state === "writing",
      sockets: 1,
      dim: state === "waiting",
      seed: 60 + i,
    });
    S.put([g.plan.x + 25, g.plan.y, g.z], p.svg, i * 100 + 50);
    over.put(
      [1, 0, i],
      D.connectorSvg(p.sockets[0], [plan.x + 60, plan.y + 6.4 + 13, z + 1.6], P, {
        tone: state === "writing" ? "lit" : "mid",
        sag: 0.04,
      }),
    );
    if (state === "writing")
      over.put(
        [2, 0, i],
        D.blockCursorSvg([g.plan.x + 40, g.plan.y + 10, g.z + g.h + 6], P, { w: 5, d: 2.2, h: 8 }),
      );
  });
  return {
    P,
    body: S.body() + over.body(),
    label:
      "A stack of three pull requests numbered 1 to 3 from the bottom, each based on the head of the one below. Each layer has its own guide panel joined only to its own diff; the agent has finished layer 1 and is writing layer 2's guide.",
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Fig 5: local first, as an architecture diagram. Your Mac's dashed boundary holds the prkit window, its process
// memory with the token, and its data folder with no token file. Exactly two connections leave: GitHub's API and
// your agent's process. Where a prkit server would be there is only a dashed, crossed-out, empty node.

function fig5() {
  const MAC = { x: 0, y: 0, w: 150, d: 120, r: 6 };
  const APP = { x: 10, y: 12, w: 80, d: 60, r: 2.4 };
  const MEM = { x: 98, y: 12, w: 44, d: 40, r: 2 };
  const TREE = { x: 98, y: 60, w: 44, d: 50, r: 2 };
  const API = { x: 190, y: -40, w: 44, d: 1.6 };
  const AGENT = { x: 214, y: 70, w: 50, d: 1.6 };
  const NONE = { x: 96, y: -60, w: 44, d: 1.6 };
  const P = fit([
    ...k.boxCorners(MAC, 0, 2),
    [API.x + API.w, API.y, 40],
    [AGENT.x + AGENT.w, AGENT.y, 40],
    [NONE.x, NONE.y, 46],
  ]);
  const S = D.sceneOf(P);
  const over = D.sceneOf(P);
  // The boundary: a dashed outline on the ground, with a computer glyph in its corner.
  S.put(
    [0, 0, -50],
    `<g transform="${D.faceTop(MAC.x, MAC.y, 0, P)}">${UI.box(0, 0, MAC.w, MAC.d, { tone: "mid", fill: "", r: 6, dash: true })}${UI.box(4, MAC.d - 9, 7, 4.6, { tone: "mid", fill: "", r: 0.6 })}${UI.line(
      [
        [7.5, MAC.d - 4.4],
        [7.5, MAC.d - 3.2],
      ],
      "mid",
    )}${UI.line(
      [
        [5.6, MAC.d - 3.2],
        [9.4, MAC.d - 3.2],
      ],
      "mid",
    )}</g>`,
  );
  S.put(
    [50, 42, 0],
    D.flatPanelSvg(APP, 0, P, {
      h: 2,
      title: [14],
      body: () =>
        [0, 1, 2, 3, 4]
          .map(
            (i) =>
              UI.emblem(["circle", "square", "triangle"][i % 3], 6, 6 + i * 9, 2) +
              UI.text(11, 6 + i * 9, [8, 30 - i * 3], "mid", 2),
          )
          .join(""),
    }),
  );
  // Process memory: cells in rows, one holding the token's key glyph.
  S.put(
    [120, 32, 0],
    D.flatPanelSvg(MEM, 0, P, {
      title: [10],
      body: () =>
        [0, 1, 2, 3]
          .map((r) =>
            [0, 1, 2, 3]
              .map((c) =>
                r === 1 && c === 2
                  ? UI.box(4 + c * 9.4, 3 + r * 7.4, 8, 6, { tone: "hi", fill: "tint" }) +
                    UI.key(5.2 + c * 9.4, 4.6 + r * 7.4, 2.6)
                  : UI.box(4 + c * 9.4, 3 + r * 7.4, 8, 6, { tone: "faint", fill: "tint" }),
              )
              .join(""),
          )
          .join(""),
    }),
  );
  // The app's data folder: folders and files, and no token file among them.
  S.put(
    [120, 85, 0],
    D.flatPanelSvg(TREE, 0, P, {
      title: [12],
      body: () =>
        [
          [0, "folder"],
          [1, "file"],
          [1, "file"],
          [0, "folder"],
          [1, "file"],
          [1, "file"],
        ]
          .map(
            ([depth, kind], i) =>
              (kind === "folder"
                ? UI.chevron(3 + depth * 4, 4 + i * 6.4, 0.9, "down", "mid")
                : "") +
              UI[kind](6 + depth * 4, 2.4 + i * 6.4, 3.2) +
              UI.text(11 + depth * 4, 4 + i * 6.4, [10 + ((i * 7) % 12)], "lo", 1.6),
          )
          .join(""),
    }),
  );
  // The two connections out, and the node that isn't there.
  S.put(
    [API.x + 22, API.y, 20],
    D.uprightPanelSvg(API, 8, 30, P, {
      title: [10],
      body: (w) =>
        UI.line(
          [
            [6, 4],
            [4, 4],
            [4, 12],
            [3, 13],
            [4, 14],
            [4, 22],
            [6, 22],
          ],
          "hi",
        ) +
        UI.line(
          [
            [w - 6, 4],
            [w - 4, 4],
            [w - 4, 12],
            [w - 3, 13],
            [w - 4, 14],
            [w - 4, 22],
            [w - 6, 22],
          ],
          "hi",
        ) +
        [0, 1, 2].map((i) => UI.text(9, 7 + i * 5, [10 + i * 4], "mid", 1.6)).join(""),
    }),
    -10,
  );
  S.put(
    [AGENT.x + 25, AGENT.y, 20],
    D.uprightPanelSvg(AGENT, 8, 32, P, {
      title: [10],
      body: (w, h) => D.terminalUi(w, h, { lines: 3 }),
    }),
    -10,
  );
  S.put(
    [NONE.x + 22, NONE.y, 20],
    `<g opacity=".7"><g transform="${D.faceFront(NONE.x, NONE.y + NONE.d, 44, P)}">${UI.box(0, 0, NONE.w, 34, { tone: "lo", fill: "", r: 1.4, dash: true })}${UI.cross(NONE.w / 2, 17, 7, "lo")}</g></g>`,
    -80,
  );
  over.put(
    [0, 0, 0],
    D.connectorSvg([APP.x + APP.w - 6, APP.y + 10, 2], [API.x + 10, API.y + 1.6, 9.6], P, {
      tone: "hi",
      sag: 0.02,
    }),
  );
  over.put(
    [0, 0, 1],
    D.connectorSvg(
      [APP.x + APP.w - 6, APP.y + APP.d - 10, 2],
      [AGENT.x + 10, AGENT.y + 1.6, 9.6],
      P,
      { tone: "lit", sag: 0.02 },
    ),
  );
  return {
    P,
    body: S.body() + over.body(),
    label:
      "Local first, as an architecture diagram: a dashed boundary for your Mac holds the prkit window, its process memory with the token's key glyph, and its data folder with no token file. Exactly two connections leave it, to GitHub's API and to your agent's terminal process. A dashed, crossed-out empty node stands where a prkit server would be.",
  };
}

// ---------------------------------------------------------------------------------------------------------------

mkdirSync(OUT, { recursive: true });
const from = (path) => relative(OUT, join(WWW, path));
const page = (name, { body, label }) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Draft ${name}</title>
<style>body{margin:0;background:var(--anatomy-page)}.box{width:${W}px;margin:24px;border:1px solid var(--border);background:var(--anatomy-card)}</style>
${["src/styles/global.css", "src/figures/kit/iso.css", "src/figures/kit/prkit-theme.css"].map((p) => `<link rel="stylesheet" href="${from(p)}">`).join("\n")}
</head><body><div class="box"><svg class="iso-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${label}"><style>${D.DIGITAL_CSS}</style>${body}</svg></div></body></html>
`;
for (const [name, build] of [
  ["fig2", fig2],
  ["fig3", fig3],
  ["fig4", fig4],
  ["fig5", fig5],
]) {
  const file = join(OUT, `draft-${name}.html`);
  writeFileSync(file, page(name, build()));
  console.log(`wrote ${relative(process.cwd(), file)}`);
}
