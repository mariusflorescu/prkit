// The stack's drawing, built once with the kit and prkit's digital materials, every part drawn the way the app shows
// it: each layer a pull request window (its place in the stack, base <- head, the stack strip, its own diff), stacked
// bottom to top, each base chip joined to the head of the layer below. Beside each window stands that layer's guide,
// joined only to its own diff. The agent is the terminal's block cursor, writing a guide row by row.
import * as k from "../kit/iso-kit.mjs";
import * as D from "../kit/prkit-digital.mjs";
import { GUIDE_ROWS, LAYERS, rowsOf } from "./model.mjs";

export const W = 640;
export const H = 480;

const { UI } = D;

// World plan, in units of about a pixel: each layer up and back from the one below.
const STEP = { x: 14, y: -34, z: 42 };
export const WINDOW = { w: 116, d: 74, h: 1.8 };
const BAR = 6.4;
// The window's body, under its title bar: the header row, the stack strip, then the diff.
const STRIP = { y: 9.6, h: 6.4, w: 34, gap: 1.6, x: 3.4 };
const DIFF_Y = 19.4;
const PITCH = 2.95;
// The guide stands clear of the window above it: right of every window's far edge.
export const GUIDE = { dx: WINDOW.w + 22, dy: 2, w: 60, d: 1.6, z: 4, h: 40 };
const GUIDE_BAR = 6.4;
const ROW_Y = (row) => GUIDE_BAR + 11 + row * 4;

export const planOf = (layer) => ({
  x: layer * STEP.x,
  y: layer * STEP.y,
  w: WINDOW.w,
  d: WINDOW.d,
  r: 2.4,
});
export const zOf = (layer) => layer * STEP.z;
export const guideOf = (layer) => {
  const plan = planOf(layer);
  return {
    x: plan.x + GUIDE.dx,
    y: plan.y + GUIDE.dy,
    w: GUIDE.w,
    d: GUIDE.d,
    z: zOf(layer) + GUIDE.z,
  };
};

export const P = k.fitProjection(
  LAYERS.flatMap((_, layer) => {
    const guide = guideOf(layer);
    return [
      ...k.boxCorners(planOf(layer), zOf(layer), zOf(layer) + WINDOW.h),
      ...k.boxCorners({ ...guide, r: 0 }, guide.z, guide.z + GUIDE.h),
    ];
  }),
  W,
  H,
  { pad: 20 },
);

/** A world point on a window's top face, from its body's own (u, v). */
const onWindow = (layer, u, v) => {
  const plan = planOf(layer);
  return [plan.x + u, plan.y + BAR + v, zOf(layer) + WINDOW.h];
};
/** A world point on a guide's front face, from the face's own (u, v), v down from its top edge. */
export const onGuide = (layer, u, v) => {
  const guide = guideOf(layer);
  return [guide.x + u, guide.y + guide.d, guide.z + GUIDE.h - v];
};

/** Where the agent's cursor stands at `u` along `row` of a guide's face, just after the last word it typed. */
const cursorAt = (layer, row, u) => onGuide(layer, u + 2.2, ROW_Y(row) + 1.6);
/** How far the cursor has moved from the start of row 0, in world units. */
export const cursorShift = (layer, row, u) => {
  const from = cursorAt(layer, 0, ROW_START);
  const to = cursorAt(layer, row, u);
  return [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
};

/**
 * How far along a guide is when `written` (0 to 1) of it is written: the row the agent is typing (-1 when it is
 * done) and how far along that row it has typed, in the face's units. Words left of that point are shown.
 */
export function typingOf(layer, written) {
  if (written >= 1) return { at: -1, u: Infinity };
  const rows = written * GUIDE_ROWS;
  const at = Math.min(GUIDE_ROWS - 1, Math.floor(rows));
  const end = rowEnd(layer, at);
  return { at, u: ROW_START + (end - ROW_START) * (rows - at) };
}

// ---------------------------------------------------------------------------------------------------------------
// The window's UI, in its own units.

/** The stack glyph: three stacked bars, this layer's filled, as "Stack 2/3" reads. */
function stackGlyph(x, y, layer) {
  return LAYERS.map((_, at) => {
    const by = y + (LAYERS.length - 1 - at) * 1.9;
    return at === layer
      ? UI.pill(x, by, 6, 1.3, "hi")
      : `<rect class="dg-stroke" data-tone="mid" x="${x}" y="${by}" width="6" height="1.3" rx=".65"/>`;
  }).join("");
}

/** A branch chip: the branch glyph and its name. */
function branchChip(x, y, w, tone) {
  return (
    UI.box(x, y, w, 4.8, { tone, fill: "tint", r: 2.4 }) +
    UI.ring(x + 2.6, y + 1.5, 0.55, tone) +
    UI.ring(x + 2.6, y + 3.4, 0.55, tone) +
    UI.line(
      [
        [x + 2.6, y + 2.05],
        [x + 2.6, y + 2.85],
      ],
      tone,
    ) +
    UI.text(x + 4.6, y + 2.4, [w - 7], tone === "hi" ? "mid" : "lo", 1.5)
  );
}

/** The stack strip under the header: one cell a layer, this one boxed, each with its guide's state icon. */
/** An open book, as lucide's book-open-text draws it: two pages from a spine, a line of text on each. */
function bookIcon(cx, cy, tone) {
  const page = (dir) =>
    UI.line(
      [
        [cx, cy - 0.9],
        [cx + dir * 0.6, cy - 1.4],
        [cx + dir * 2.2, cy - 1.4],
        [cx + dir * 2.2, cy + 1.2],
        [cx + dir * 0.6, cy + 1.2],
        [cx, cy + 1.6],
        [cx, cy - 0.9],
      ],
      tone,
    ) +
    UI.line(
      [
        [cx + dir * 0.7, cy - 0.3],
        [cx + dir * 1.5, cy - 0.3],
      ],
      tone,
    );
  return page(-1) + page(1);
}

/**
 * The stack strip under the header, as the app draws it: one cell a layer, this one boxed, each with its position,
 * the pull request's state, its number and title, and a book once it has a guide: muted while it is being written
 * (queued included, as the app shows a preparing review), full once it is ready, nothing before.
 */
function stripUi(layer, guides) {
  return LAYERS.map((_, at) => {
    const x = STRIP.x + at * (STRIP.w + STRIP.gap);
    const cy = STRIP.y + STRIP.h / 2;
    const own = at === layer;
    const state = guides[at].state;
    const look = state === "queued" ? "writing" : state;
    const shown = (name) => (look === name ? "" : ' visibility="hidden"');
    return (
      UI.box(x, STRIP.y, STRIP.w, STRIP.h, {
        tone: own ? "hi" : "faint",
        fill: own ? "paper" : "tint",
        r: 1.2,
      }) +
      // Its position, from the bottom, as pips.
      Array.from({ length: at + 1 }, (_, i) =>
        UI.dot(x + 1.9, cy + 1.4 - i * 1.4, 0.45, "lo"),
      ).join("") +
      // The pull request's state: open.
      UI.ring(x + 4.8, cy - 1, 0.6, own ? "hi" : "mid") +
      UI.ring(x + 4.8, cy + 1.2, 0.6, own ? "hi" : "mid") +
      UI.line(
        [
          [x + 4.8, cy - 0.4],
          [x + 4.8, cy + 0.6],
        ],
        own ? "hi" : "mid",
      ) +
      UI.text(x + 7, cy, [3.6], own ? "hi" : "mid", 1.5) +
      UI.text(x + 12, cy, [9 + ((at * 7) % 7), 4], own ? "mid" : "lo", 1.5) +
      `<g data-strip="${at}" data-state="writing"${shown("writing")}>${bookIcon(x + STRIP.w - 3.4, cy, "lo")}</g>` +
      `<g data-strip="${at}" data-state="ready"${shown("ready")}>${bookIcon(x + STRIP.w - 3.4, cy, "hi")}</g>`
    );
  }).join("");
}

/** The layer's own diff, as the Files tab lists it: a header per file, then context, removed and added lines. */
function diffUi(layer, w) {
  const random = D.seeded(40 + layer * 9);
  const out = [];
  let number = 12 + layer * 7;
  rowsOf(layer).forEach((kind, row) => {
    const cy = DIFF_Y + row * PITCH + PITCH / 2;
    if (kind === "file") {
      const file =
        LAYERS[layer].files[
          rowsOf(layer)
            .slice(0, row)
            .filter((r) => r === "file").length
        ];
      out.push(
        `<rect class="dg-bar" x="2" y="${(cy - PITCH / 2 + 0.2).toFixed(2)}" width="${w - 4}" height="${(PITCH - 0.4).toFixed(2)}" rx=".6"/>`,
        UI.chevron(4.6, cy, 0.8, "down"),
        UI.file(7, cy - 1.1, 2.2, "hi"),
        UI.text(10.6, cy, [6 + random() * 4, 12 + random() * 12], "mid", 1.4),
        UI.text(w - 14, cy, [1.2 + file.added * 0.5], "hi", 1.2),
        file.removed
          ? `<rect class="dg-stroke" data-tone="lo" x="${(w - 12.6 + file.added * 0.5 + 1.4).toFixed(2)}" y="${(cy - 0.6).toFixed(2)}" width="${(1 + file.removed * 0.5).toFixed(2)}" height="1.2" rx=".6"/>`
          : "",
      );
      return;
    }
    const indent = kind === "ctx" ? 0 : 3.2 * Math.floor(random() * 3);
    const lens = [
      4 + random() * 6,
      10 + random() * 24,
      ...(random() > 0.4 ? [4 + random() * 14] : []),
      ...(random() > 0.6 ? [5 + random() * 10] : []),
    ];
    if (kind === "add")
      out.push(
        `<rect class="dg-tint" x="2" y="${(cy - PITCH / 2 + 0.15).toFixed(2)}" width="${w - 4}" height="${(PITCH - 0.3).toFixed(2)}" rx=".5"/>`,
        UI.line(
          [
            [7.6, cy],
            [9.6, cy],
          ],
          "hi",
        ),
        UI.line(
          [
            [8.6, cy - 1],
            [8.6, cy + 1],
          ],
          "hi",
        ),
      );
    if (kind === "del")
      out.push(
        `<rect class="dg-sunk" x="2" y="${(cy - PITCH / 2 + 0.15).toFixed(2)}" width="${w - 4}" height="${(PITCH - 0.3).toFixed(2)}" rx=".5"/>`,
        UI.line(
          [
            [7.6, cy],
            [9.6, cy],
          ],
          "mid",
        ),
      );
    out.push(UI.pill(3.4, cy - 0.5, number >= 10 ? 2.4 : 1.4, 1, kind === "del" ? "faint" : "lo"));
    if (kind !== "del") number++;
    if (kind === "del") {
      let at = 12 + indent;
      for (const len of lens) {
        out.push(
          `<rect class="dg-hollow" x="${at.toFixed(2)}" y="${(cy - 0.7).toFixed(2)}" width="${len.toFixed(2)}" height="1.4" rx=".7"/>`,
        );
        at += len + 1.2;
      }
      out.push(
        UI.line(
          [
            [11.4 + indent, cy],
            [at - 0.6, cy],
          ],
          "mid",
        ),
      );
    } else out.push(UI.text(12 + indent, cy, lens, kind === "add" ? "mid" : "lo", 1.4, 1.2));
  });
  return out.join("");
}

/** The window's body under its title bar: the header row, the strip, a rule, the diff. */
function windowUi(layer, w, guides) {
  // The base chip names the branch below (the trunk for layer 1); the head chip is this layer's branch.
  return (
    stackGlyph(4, 1.6, layer) +
    UI.text(12.4, 3.6, [5], "mid", 1.8) +
    UI.text(19, 3.6, [16 + layer * 4, 10], "hi", 1.8) +
    branchChip(w - 58, 1.2, 22, layer === 0 ? "hi" : "lo") +
    UI.line(
      [
        [w - 28.6, 3.6],
        [w - 34.4, 3.6],
      ],
      "hi",
    ) +
    UI.line(
      [
        [w - 32.8, 2.4],
        [w - 34.4, 3.6],
        [w - 32.8, 4.8],
      ],
      "hi",
    ) +
    branchChip(w - 27, 1.2, 24, "hi") +
    stripUi(layer, guides) +
    UI.line(
      [
        [2, DIFF_Y - 1.4],
        [w - 2, DIFF_Y - 1.4],
      ],
      "faint",
    ) +
    diffUi(layer, w)
  );
}

// ---------------------------------------------------------------------------------------------------------------
// The guide panel.

/** Each guide row's words, so the cursor knows where a row ends. Row 0 is the chapter's title. */
const guideWords = LAYERS.map((_, layer) => {
  const random = D.seeded(70 + layer * 13);
  return Array.from({ length: GUIDE_ROWS }, (_, row) => {
    const lens = [];
    let at = 5;
    const count = row === 0 ? 3 : 2 + Math.floor(random() * 3);
    for (let i = 0; i < count; i++) {
      const len = row === 0 ? 8 + random() * 8 : 4 + random() * 11;
      if (at + len > GUIDE.w - 12) break;
      lens.push(len);
      at += len + 1.4;
    }
    return lens;
  });
});
/** The row on which a guide writes the layer below as #123: a reference chip, not its diff. */
const REF_ROW = 3;
const ROW_START = 5;
const rowEnd = (layer, row) => {
  const lens = guideWords[layer][row];
  const ref = layer > 0 && row === REF_ROW ? 9.4 : 0;
  return 5 + ref + lens.reduce((sum, len) => sum + len + 1.4, 0) - 1.4;
};

function guideRowsUi(layer, written) {
  const { at: writing, u } = typingOf(layer, written);
  const shown = (row, x) => writing < 0 || row < writing || (row === writing && x < u);
  return guideWords[layer]
    .map((lens, row) => {
      const y = ROW_Y(row);
      const h = row === 0 ? 2.6 : 1.6;
      let at = 5;
      const marks = [];
      if (layer > 0 && row === REF_ROW) {
        // "#123": the layer below, written as a reference.
        marks.push(
          `<g data-ref="5"${shown(row, 5) ? "" : ' visibility="hidden"'}>`,
          UI.box(5, y - 1.6, 8, 3.2, { tone: "mid", fill: "tint", r: 1.6 }),
          UI.line(
            [
              [7, y - 0.9],
              [6.6, y + 0.9],
            ],
            "mid",
          ),
          UI.line(
            [
              [8.2, y - 0.9],
              [7.8, y + 0.9],
            ],
            "mid",
          ),
          UI.pill(9.2, y - 0.5, 2.8, 1, "mid"),
          `</g>`,
        );
        at += 9.4;
      }
      for (const len of lens) {
        const rest = row === 0 ? "hi" : "lo";
        marks.push(
          UI.pill(at, y - h / 2, len, h, row === writing ? "lit" : rest).replace(
            'class="dg-pill"',
            `class="dg-pill" data-rest="${rest}"${shown(row, at) ? "" : ' visibility="hidden"'}`,
          ),
        );
        at += len + 1.4;
      }
      return `<g data-row="${row}">${marks.join("")}</g>`;
    })
    .join("");
}

function guideSvg(layer, written) {
  const guide = guideOf(layer);
  const solid = k.solidSvg(k.slabOf({ ...guide, r: 0.6 }, guide.z, GUIDE.h, P, 2), {
    tone: "hi",
    crease: "faint",
  });
  const face =
    UI.titleBar(GUIDE.w, GUIDE_BAR, { tag: 1 }) +
    // The chapter's badge (core) and its number.
    UI.pill(5, GUIDE_BAR + 3.2, 4.4, 4.4, "hi").replace(/rx="[^"]*"/, 'rx="0.6"') +
    UI.dot(12, GUIDE_BAR + 5.4, 1.1, "mid") +
    guideRowsUi(layer, written) +
    // The anchor's end, where the connector to this layer's diff leaves.
    UI.dot(GUIDE.w / 2, GUIDE.h - 2.6, 1, "hi");
  return `${solid}<g transform="${D.faceFront(guide.x, guide.y + guide.d, guide.z + GUIDE.h, P)}">${face}</g>`;
}

/** Before a guide exists: its place as a dashed frame, with a waiting ring while it is queued. */
function ghostSvg(layer, queued) {
  const guide = guideOf(layer);
  return `<g transform="${D.faceFront(guide.x, guide.y + guide.d, guide.z + GUIDE.h, P)}">${UI.box(0.4, 0.4, GUIDE.w - 0.8, GUIDE.h - 0.8, { tone: "lo", fill: "", r: 1, dash: true })}<g data-part="queued-${layer}"${queued ? "" : ' visibility="hidden"'}>${UI.pending(GUIDE.w / 2, GUIDE.h / 2, 3.4, "mid")}</g></g>`;
}

/** The agent: the kit's block cursor, standing on the guide's face after the row it is writing. */
function cursorSvg(layer) {
  const [x, y, z] = cursorAt(layer, 0, ROW_START);
  return D.blockCursorSvg([x, y + 0.8, z - 2.2], P, {
    w: 2.6,
    d: 1.6,
    h: 4.4,
    prompt: 1,
    id: `sg-cursor-${layer}`,
  });
}

/** The rows a guide covers: every changed line of its own layer, from the first to the last. */
const rangeOf = (layer) => {
  const rows = rowsOf(layer);
  const first = rows.findIndex((kind) => kind === "add" || kind === "del");
  return [DIFF_Y + first * PITCH + 0.3, DIFF_Y + rows.length * PITCH - 0.3];
};
/** How far in from the window's right edge the range's bracket runs. */
const RANGE = 3.4;
/** The range's bracket along the diff's right edge, as a selected range is marked: lit while the agent writes. */
function rangeSvg(layer, tone) {
  const [y0, y1] = rangeOf(layer);
  const x = WINDOW.w - RANGE;
  return `<g transform="${D.faceTop(planOf(layer).x, planOf(layer).y + BAR, zOf(layer) + WINDOW.h, P)}">${UI.line(
    [
      [x - 1.6, y0],
      [x, y0],
      [x, y1],
      [x - 1.6, y1],
    ],
    tone,
    false,
    true,
  ).replace('class="dg-stroke"', `class="dg-stroke" data-part="range-${layer}"`)}</g>`;
}
/** Where a guide's connector lands: the middle of its range's bracket. */
const anchorOf = (layer) => {
  const [y0, y1] = rangeOf(layer);
  return onWindow(layer, WINDOW.w - RANGE, (y0 + y1) / 2);
};

/** The connector from a guide down to its own layer's diff, with a dot at each end. */
export function connectorOf(layer) {
  const from = onGuide(layer, GUIDE.w / 2, GUIDE.h - 2.6);
  const to = anchorOf(layer);
  return { d: D.threadPath(from, to, P, 0.04), ends: [k.iso(from, P), k.iso(to, P)] };
}

// ---------------------------------------------------------------------------------------------------------------

/** The whole drawing, in the state the tour is at: `guides` from the model's stateAt. */
export function drawing(guides) {
  const hidden = (on) => (on ? "" : ' visibility="hidden"');
  const out = [];
  // The windows bottom to top, each with the dashed line from its base chip down to the head chip of the layer
  // below.
  LAYERS.forEach((_, layer) => {
    const plan = planOf(layer);
    const z = zOf(layer);
    const windowSvg = D.flatPanelSvg(plan, z, P, {
      h: WINDOW.h,
      title: [16, 8],
      body: (w) => windowUi(layer, w, guides),
    });
    const below =
      layer > 0
        ? k.lineSvg(
            k.pathOf([
              k.iso(onWindow(layer, WINDOW.w - 47, 6), P),
              k.iso(onWindow(layer - 1, WINDOW.w - 15, 6), P),
            ]),
            { tone: "lo", dashed: true, free: true },
          )
        : "";
    out.push(`<g data-lift="${layer}">${windowSvg}</g>`, `<g data-lift="${layer}">${below}</g>`);
  });
  // The guides top to bottom, each with its connector: each stands in front of the window above it.
  LAYERS.map((_, layer) => layer)
    .toReversed()
    .forEach((layer) => {
      const { state, written } = guides[layer];
      const drawn = state === "writing" || state === "ready";
      const typing = typingOf(layer, written);
      const link = connectorOf(layer);
      out.push(
        `<g data-lift="${layer}">`,
        `<g data-part="ghost-${layer}"${hidden(!drawn)}>${ghostSvg(layer, state === "queued")}</g>`,
        `<g data-part="guide-${layer}"${hidden(drawn)}>${guideSvg(layer, written)}</g>`,
        // Its connector, after it, so the line leaves from the socket on its face.
        `<g data-part="link-${layer}"${hidden(drawn)}>${rangeSvg(layer, state === "writing" ? "lit" : "hi")}${k.lineSvg(link.d, { tone: state === "writing" ? "lit" : "mid", className: "sg-link" })}${k.dotsSvg(link.ends, { size: 0.9, tone: "hi" })}</g>`,
        `<g data-part="cursor-${layer}"${hidden(state === "writing")} transform="${k.translateAlong(P, cursorShift(layer, Math.max(0, typing.at), Math.min(typing.u, 99)))}">${cursorSvg(layer)}</g>`,
        `</g>`,
      );
    });
  return out.join("");
}
