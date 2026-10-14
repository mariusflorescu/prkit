// prkit's digital materials, next to the vendored kit (not part of it): the things a pull request is made of,
// built as solid isometric objects with the kit. Code is the material: a line is a row of token pills, a file is a
// thin bevelled sheet with a gutter and a header, a diff raises its added lines and hollows its removed ones.
// Every builder puts depth-keyed items into a scene, so callers paint everything back to front in one pass.
import * as k from "./iso-kit.mjs";
import * as A from "./audit.mjs";

// The styles these builders draw with, on the kit's tones, so both themes follow.
export const DIGITAL_CSS = `
.dg-pill{stroke:none}
.dg-pill[data-tone="hi"]{fill:var(--anatomy-hi)}
.dg-pill[data-tone="mid"]{fill:var(--anatomy-mid)}
.dg-pill[data-tone="lo"]{fill:var(--anatomy-lo)}
.dg-pill[data-tone="faint"]{fill:var(--anatomy-faint)}
.dg-pill[data-tone="lit"]{fill:var(--anatomy-lit)}
.dg-hollow{fill:none;stroke:var(--anatomy-lo);stroke-width:.55;vector-effect:non-scaling-stroke}
.dg-hollow[data-tone="lit"]{stroke:var(--anatomy-lit)}
.dg-band{stroke:none;fill:var(--anatomy-shade-2)}
.dg-band[data-tone="faint"]{fill:var(--anatomy-shade-3)}
.dg-sunk{stroke:none;fill:var(--anatomy-shade-0)}
.dg-added>.iso-top{fill:var(--anatomy-top)}
.dg-select{fill:var(--anatomy-lit);fill-opacity:.13;stroke:var(--anatomy-lit);stroke-width:.6;stroke-opacity:.8;vector-effect:non-scaling-stroke}
.dg-face{fill:var(--anatomy-lit)}
.dg-face[data-light="0"]{fill-opacity:1}
.dg-face[data-light="1"]{fill-opacity:.78}
.dg-face[data-light="2"]{fill-opacity:.55}
.dg-face[data-light="3"]{fill-opacity:.32}
.dg-gem-edge{fill:none;stroke:var(--anatomy-lit);stroke-width:.6;stroke-linejoin:round;vector-effect:non-scaling-stroke}
.dg-glow-core{stop-color:var(--anatomy-lit);stop-opacity:.34}
.dg-glow-edge{stop-color:var(--anatomy-lit);stop-opacity:0}
.dg-plane-lo{stop-color:var(--anatomy-lit);stop-opacity:.26}
.dg-plane-hi{stop-color:var(--anatomy-lit);stop-opacity:0}
.dg-beam-lo{stop-color:var(--anatomy-lit);stop-opacity:.42}
.dg-beam-hi{stop-color:var(--anatomy-lit);stop-opacity:.06}
.dg-glass .dg-sheet>.iso-solid>.iso-fill{fill-opacity:0}
.dg-glass .dg-sheet>.iso-solid>.iso-top{fill:var(--anatomy-shade-1);fill-opacity:.5}
.dg-glass .dg-sheet>.iso-solid>.iso-shade{fill-opacity:.8}
.dg-glass .dg-sheet>.iso-solid>.iso-bevel{stroke:var(--anatomy-paper);stroke-width:1.4;stroke-opacity:.95}
.dg-glass .dg-sheet>.iso-solid>.iso-edge{stroke:var(--anatomy-hi)}
.dg-glass .dg-band{fill-opacity:.55}
.dg-panel.dg-glass>.iso-solid>.iso-fill{fill-opacity:.25}
.dg-panel.dg-glass>.iso-solid>.iso-shade{fill-opacity:.55}
.dg-panel.dg-glass>.iso-solid>.iso-edge{stroke:var(--anatomy-mid)}
.dg-glint{fill:none;stroke:var(--anatomy-top);stroke-width:1.1;stroke-linecap:round;vector-effect:non-scaling-stroke}
.dg-dim{opacity:.6}
.dg-gutter-sel{stroke:none;fill:var(--anatomy-lo);fill-opacity:.55}
.dg-stroke{fill:none;stroke:var(--anatomy-mid);stroke-width:.6;stroke-linecap:round;stroke-linejoin:round;vector-effect:non-scaling-stroke}
.dg-stroke[data-tone="hi"]{stroke:var(--anatomy-hi)}
.dg-stroke[data-tone="lo"]{stroke:var(--anatomy-lo)}
.dg-stroke[data-tone="faint"]{stroke:var(--anatomy-faint)}
.dg-stroke[data-tone="lit"]{stroke:var(--anatomy-lit)}
.dg-stroke[data-dash]{stroke-dasharray:2.4 1.8}
.dg-stroke[data-bold]{stroke-width:1.3}
.dg-paper{fill:var(--anatomy-top);stroke:none}
.dg-bar{fill:var(--anatomy-shade-2);stroke:none}
.dg-tint{fill:var(--anatomy-shade-3);stroke:none}
.dg-lit-fill{fill:var(--anatomy-lit);stroke:none}
.dg-lit-soft{fill:var(--anatomy-lit);fill-opacity:.14;stroke:none}
`;

// ---------------------------------------------------------------------------------------------------------------
// Scene: depth-keyed items, painted back to front.

export function sceneOf(P) {
  const R = A.recorder(P);
  return {
    P,
    R,
    /**
     * Put markup in at a world point; a larger depth paints later. `bias` nudges ties. `shapes` records the item's
     * true shape for the audit's painter (A.settle) and checks.
     */
    put(at, svg, bias = 0, shapes = [], name) {
      return R.put({ at, bias, svg, shapes, name, piece: "fig" });
    },
    /** Put markup in just after another item's depth: for things lying on or hovering over a sheet. */
    on(at, svg, order = 1, shapes = [], name) {
      return R.put({ key: k.depthOf(at, P) + 0.001 * order, svg, shapes, name, piece: "fig" });
    },
    /** The markup, back to front. With `settle`, the audit measures true depth where recorded shapes overlap. */
    body({ settle = false } = {}) {
      if (settle) A.settle(R, P);
      return R.items
        .slice()
        .sort((a, b) => a.key - b.key)
        .map((item) => item.svg)
        .join("");
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Code as material.

/** A small seeded generator, so the same file always draws the same code. */
export function seeded(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/**
 * Lines of code, as rows of token pills. `kinds` lists each row: "ctx", "add", "del", "blank" or "hunk". Each
 * token is `{ len, tone }`: keywords short and `hi`, names longer and `mid`, literals `lo`.
 */
export function codeOf(kinds, seed = 7) {
  const random = seeded(seed);
  let indent = 0;
  return kinds.map((kind, row) => {
    if (kind === "blank" || kind === "hunk") return { kind, indent: 0, tokens: [] };
    const roll = random();
    if (row > 0 && roll < 0.3) indent = Math.min(3, indent + 1);
    else if (roll > 0.78) indent = Math.max(0, indent - 1);
    const count = 2 + Math.floor(random() * 2);
    const tokens = [];
    for (let i = 0; i < count; i++) {
      const pick = random();
      if (i === 0 && pick < 0.55) tokens.push({ len: 5 + random() * 3, tone: "mid" });
      else if (pick < 0.68) tokens.push({ len: 8 + random() * 10, tone: "lo" });
      else tokens.push({ len: 4 + random() * 6, tone: "faint" });
    }
    return { kind, indent, tokens };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// The file sheet.

export const SHEET = {
  pitch: 5.2, // one line of code
  pill: 2.4, // a token's depth on the sheet
  gap: 1.3, // between tokens
  header: 9, // the header strip, along the back edge
  gutter: 11, // line numbers and diff notches, before the code
  indent: 3.4,
  h: 1.3, // the sheet's own thickness
  rise: 0.55, // an added line stands this much proud of the sheet
};

/** Where a row's centre sits on a sheet, as a world y. */
export const rowY = (sheet, row) => sheet.y + SHEET.header + 3.2 + (row + 0.5) * SHEET.pitch;

/** The rows a sheet needs for its code, header and margins. */
export const sheetDepth = (rows) => SHEET.header + 3.2 + rows * SHEET.pitch + 3.4;

function pillsOn(tokens, x, y, z, P) {
  const byTone = {};
  let at = x;
  for (const token of tokens) {
    const plan = { x: at, y: y - SHEET.pill / 2, w: token.len, d: SHEET.pill, r: SHEET.pill / 2 };
    (byTone[token.tone] ??= []).push(k.planOutline(plan, z, P, 2));
    at += token.len + SHEET.gap;
  }
  return { byTone, end: at - SHEET.gap };
}

const pillSvg = (byTone) =>
  Object.entries(byTone)
    .map(([tone, list]) => `<path class="dg-pill" data-tone="${tone}" d="${list.join("")}"/>`)
    .join("");

/**
 * A file sheet lying flat at height `z`, its lines along +x and its rows stacked along +y, the header strip on the
 * back edge. `lit` is a set of rows the agent is touching (drawn rose). Returns the markup and the row geometry,
 * so threads, pins and beams can land on exact lines. `read` closes the header with a check, the file checked off
 * as read; `note` adds a one-line note under the header. `part` names them (`<part>-read`, `<part>-note`) for a page
 * that shows them over time.
 */
export function fileSheetSvg(
  sheet,
  z,
  P,
  {
    code,
    lit = new Set(),
    seed = 3,
    glyph = "dot",
    tone = "hi",
    numbers = true,
    glass = false,
    marks = [],
    notes = 0,
    read = false,
    note = false,
    part = "",
  } = {},
) {
  const { x, y, w } = sheet;
  const d = sheetDepth(code.length);
  const top = z + SHEET.h;
  const out = [];
  const plan = { x, y, w, d, r: 2.2 };
  out.push(
    k.solidSvg(k.slabOf(plan, z, SHEET.h, P, 3, 0.7), {
      tone,
      crease: "faint",
      halo: !glass,
    }),
  );

  // Header strip: a raised tab with the file's glyph and its name as pills, and the +/- count as two tiny pills.
  const head = { x: x + 1.8, y: y + 1.8, w: w - 3.6, d: SHEET.header - 2.6, r: 1.2 };
  out.push(k.solidSvg(k.slabOf(head, top, 0.6, P, 2, 0.35), { tone: "mid", crease: "faint" }));
  const hz = top + 0.6;
  const hy = head.y + head.d / 2;
  // The header bar as a diff viewer draws it: a collapse chevron, the file icon, the path, the review notes, the counts.
  out.push(
    k.lineSvg(
      k.onTop(
        [
          [head.x + 1.6, hy - 1],
          [head.x + 2.6, hy],
          [head.x + 1.6, hy + 1],
        ],
        hz,
        P,
      ),
      { tone: "hi", free: true },
    ),
  );
  out.push(glyphSvg(glyph, [head.x + 5.4, hy, hz], 1.4, P));
  const random = seeded(seed * 31 + 5);
  const name = [
    { len: 5 + random() * 4, tone: "lo" },
    { len: 8 + random() * 10, tone: "mid" },
  ];
  const named = pillsOn(name, head.x + 8.2, hy, hz, P);
  out.push(pillSvg(named.byTone));
  const added = code.filter((line) => line.kind === "add").length;
  const removed = code.filter((line) => line.kind === "del").length;
  // A read check closes the header; the counts move up to make room.
  const countX = head.x + head.w - (read ? 7.4 : 3);
  const per = 0.7;
  if (removed)
    out.push(
      `<path class="dg-hollow" d="${k.planOutline({ x: countX - removed * per - 1, y: hy - 0.8, w: removed * per + 1, d: 1.6, r: 0.8 }, hz, P, 2)}"/>`,
    );
  const addX = countX - (removed ? removed * per + 2.2 : 0);
  out.push(
    `<path class="dg-pill" data-tone="mid" d="${k.planOutline({ x: addX - added * per - 1, y: hy - 0.8, w: added * per + 1, d: 1.6, r: 0.8 }, hz, P, 2)}"/>`,
  );
  if (notes) {
    // The review-note chip: a comment glyph and one pip per note, ahead of the counts.
    const nx = addX - added * per - 1 - 4.6 - notes * 1.8;
    out.push(
      `<g transform="${faceTop(nx, hy - 1.4, hz, P)}">${UI.comment(0, 0, 2.8)}${Array.from({ length: notes }, (_, i) => UI.dot(4.4 + i * 1.8, 1.4, 0.6, "hi")).join("")}</g>`,
    );
  }

  const partOf = (name) => (part ? ` data-part="${part}-${name}"` : "");
  if (read)
    out.push(
      `<g${partOf("read")} transform="${faceTop(head.x + head.w - 4.6, hy - 1.6, hz, P)}">${UI.line(
        [
          [0.3, 1.7],
          [1.3, 2.8],
          [3.1, 0.5],
        ],
        "hi",
        false,
        true,
      )}</g>`,
    );
  if (note) {
    // One line of words in the margin under the header, set off by a rule as a note is: what this file does.
    const words = seeded(seed * 17 + 3);
    out.push(
      `<g${partOf("note")} transform="${faceTop(x + SHEET.gutter, y + SHEET.header + 1.2, top, P)}">${UI.pill(0, -1, 0.7, 2, "hi")}${UI.text(1.8, 0, [8 + words() * 6, 5 + words() * 5, 7 + words() * 6], "mid", 1.5, 1.2)}</g>`,
    );
  }

  // Gutter rule, from under the header to the bottom margin.
  const gx = x + SHEET.gutter - 2;
  out.push(k.lineSvg(k.lineOnTop([gx, head.y + head.d], [gx, y + d], top, P), { tone: "faint" }));

  // Marked ranges (a chapter's anchors): a band under the rows and a bracket in the gutter.
  for (const [first, last] of marks) {
    const y0 = rowY(sheet, first) - SHEET.pitch / 2 + 0.25;
    const y1 = rowY(sheet, last) + SHEET.pitch / 2 - 0.25;
    out.push(
      `<path class="dg-band" data-tone="faint" d="${k.planOutline({ x: x + 1.2, y: y0, w: w - 2.4, d: y1 - y0, r: 0.9 }, top, P, 2)}"/>`,
    );
    // The selected range's line numbers light up in the gutter, as a diff viewer marks a selected range.
    out.push(
      `<path class="dg-gutter-sel" d="${k.planOutline({ x: x + 1.2, y: y0, w: SHEET.gutter - 3.4, d: y1 - y0, r: 0.6 }, top, P, 2)}"/>`,
    );
  }

  // Rows.
  const rows = [];
  let number = 1;
  const bands = [];
  const sunk = [];
  const raised = [];
  const strikes = [];
  const hollow = [];
  const solid = {};
  const notches = [];
  const nums = [];
  const hunks = [];
  code.forEach((line, row) => {
    const cy = rowY(sheet, row);
    const cx = x + SHEET.gutter + 1.2 + line.indent * SHEET.indent;
    const isLit = lit.has(row);
    if (line.kind === "hunk") {
      bands.push(
        k.planOutline(
          {
            x: gx + 0.8,
            y: cy - SHEET.pitch / 2 + 0.5,
            w: w - SHEET.gutter + 0.6,
            d: SHEET.pitch - 1,
            r: 0.6,
          },
          top,
          P,
          2,
        ),
      );
      hunks.push(row);
      const dots = [0, 1].map((i) =>
        k.planOutline({ x: cx + i * 2.6, y: cy - 0.6, w: 1.2, d: 1.2, r: 0.6 }, top, P, 2),
      );
      (solid.lo ??= []).push(...dots);
      const rest = pillsOn(
        [
          { len: 9, tone: "faint" },
          { len: 5, tone: "faint" },
        ],
        cx + 6.4,
        cy,
        top,
        P,
      );
      for (const [t, list] of Object.entries(rest.byTone)) (solid[t] ??= []).push(...list);
      rows.push({ row, y: cy, z: top, x0: cx, x1: rest.end, kind: line.kind });
      return;
    }
    const lineZ = line.kind === "add" ? top + SHEET.rise : top;
    if (line.kind !== "blank" && numbers) {
      const shown = line.kind === "del" ? "faint" : "lo";
      const len = number >= 10 ? 2.6 : 1.4;
      (nums[shown] ??= []).push(
        k.planOutline({ x: x + 6.2 - len, y: cy - 0.6, w: len, d: 1.2, r: 0.6 }, top, P, 2),
      );
    }
    if (line.kind !== "del") number++;
    if (line.kind === "add") {
      raised.push({
        x: gx + 0.8,
        y: cy - SHEET.pitch / 2 + 0.35,
        w: w - SHEET.gutter + 0.6,
        d: SHEET.pitch - 0.7,
        r: 0.7,
      });
      const nx = x + 7.6;
      notches.push(
        k.lineOnTop([nx - 1.3, cy], [nx + 1.3, cy], top, P),
        k.lineOnTop([nx, cy - 1.3], [nx, cy + 1.3], top, P),
      );
    }
    if (line.kind === "del") {
      sunk.push(
        k.planOutline(
          {
            x: gx + 0.8,
            y: cy - SHEET.pitch / 2 + 0.35,
            w: w - SHEET.gutter + 0.6,
            d: SHEET.pitch - 0.7,
            r: 0.7,
          },
          top,
          P,
          2,
        ),
      );
      const nx = x + 7.6;
      notches.push(k.lineOnTop([nx - 1.3, cy], [nx + 1.3, cy], top, P));
    }
    const pills = pillsOn(line.tokens, cx, cy, lineZ, P);
    if (line.kind === "del") {
      for (const list of Object.values(pills.byTone)) hollow.push(...list);
      if (line.tokens.length)
        strikes.push(k.lineOnTop([cx - 0.6, cy], [pills.end + 0.6, cy], top, P));
    } else if (isLit) {
      for (const list of Object.values(pills.byTone))
        (solid.litRow ??= []).push({ list, z: lineZ });
    } else if (line.kind === "add") {
      for (const [t, list] of Object.entries(pills.byTone))
        ((solid.raised ??= {})[t] ??= []).push(...list);
    } else for (const [t, list] of Object.entries(pills.byTone)) (solid[t] ??= []).push(...list);
    rows.push({
      row,
      y: cy,
      z: lineZ,
      x0: cx,
      x1: line.tokens.length ? pills.end : cx,
      kind: line.kind,
    });
  });

  // Hunk brackets: a "[" in the gutter from each hunk header down to the next hunk or the end.
  hunks.forEach((start, index) => {
    const end = (hunks[index + 1] ?? code.length) - 1;
    const y0 = rowY(sheet, start) + 0.6;
    const y1 = rowY(sheet, end) + SHEET.pitch / 2 - 0.6;
    // A thin bar beside the gutter rule, the hunk's extent.
    out.push(
      `<path class="dg-pill" data-tone="mid" d="${k.planOutline({ x: x + 9.3, y: y0, w: 0.9, d: y1 - y0, r: 0.45 }, top, P, 2)}"/>`,
    );
  });

  out.push(`<path class="dg-band" d="${bands.join("")}"/>`);
  if (sunk.length) out.push(`<path class="dg-sunk" d="${sunk.join("")}"/>`);
  for (const [t, list] of Object.entries(nums))
    out.push(`<path class="dg-pill" data-tone="${t}" d="${list.join("")}"/>`);
  if (strikes.length) out.push(k.lineSvg(strikes.join(""), { tone: "mid" }));
  if (hollow.length) out.push(`<path class="dg-hollow" d="${hollow.join("")}"/>`);
  // Context reads quieter than the change: its pills drop a tone, the added lines' pills gain one.
  const quieter = { mid: "lo", lo: "faint", faint: "faint" };
  const louder = { mid: "hi", lo: "mid", faint: "lo" };
  const flat = {};
  for (const [t, list] of Object.entries(solid)) {
    if (t === "raised" || t === "litRow") continue;
    const tone = quieter[t] ?? t;
    (flat[tone] ??= []).push(...list);
  }
  out.push(pillSvg(flat));
  // A run of added lines rises as one block, then its pills sit on top.
  const runs = [];
  for (const band of raised) {
    const last = runs[runs.length - 1];
    if (last && Math.abs(last.y + last.d + 0.7 - band.y) < 0.01) last.d = band.y + band.d - last.y;
    else runs.push({ ...band });
  }
  for (const run of runs)
    out.push(
      k.solidSvg(k.slabOf(run, top, SHEET.rise, P, 2), {
        tone: "mid",
        crease: "none",
        className: "dg-added",
      }),
    );
  if (solid.raised) {
    const loud = {};
    for (const [t, list] of Object.entries(solid.raised))
      (loud[louder[t] ?? t] ??= []).push(...list);
    out.push(pillSvg(loud));
  }
  if (notches.length) out.push(k.lineSvg(notches.join(""), { tone: "hi", free: true }));
  if (solid.litRow)
    out.push(
      `<path class="dg-pill" data-tone="lit" d="${solid.litRow.flatMap((r) => r.list).join("")}"/>`,
    );
  return { svg: `<g class="dg-sheet">${out.join("")}</g>`, rows, top, d, plan };
}

/** A small mark that tells a file or an account apart by shape, never by colour. */
export function glyphSvg(kind, [cx, cy, z], r, P, tone = "hi") {
  if (kind === "dot")
    return `<path class="dg-pill" data-tone="${tone}" d="${k.ring(cx, cy, r * 0.75, z, P, 14)}"/>`;
  if (kind === "ring") return k.lineSvg(k.ring(cx, cy, r * 0.8, z, P, 16), { tone });
  if (kind === "square")
    return `<path class="dg-pill" data-tone="${tone}" d="${k.planOutline({ x: cx - r * 0.7, y: cy - r * 0.7, w: r * 1.4, d: r * 1.4, r: 0.2 }, z, P, 1)}"/>`;
  if (kind === "triangle")
    return `<path class="dg-pill" data-tone="${tone}" d="${k.onTop(
      [
        [cx - r, cy + r * 0.8],
        [cx + r, cy + r * 0.8],
        [cx, cy - r],
      ],
      z,
      P,
      true,
    )}"/>`;
  // "page": a sheet with a folded corner.
  const s = r;
  return k.lineSvg(
    k.onTop(
      [
        [cx - s * 0.7, cy - s],
        [cx + s * 0.25, cy - s],
        [cx + s * 0.7, cy - s * 0.55],
        [cx + s * 0.7, cy + s],
        [cx - s * 0.7, cy + s],
      ],
      z,
      P,
      true,
    ),
    { tone },
  );
}

// ---------------------------------------------------------------------------------------------------------------
// People and accounts.

/** A person: a raised disc carrying their account's emblem. */
export function avatarSvg([cx, cy, z], r, emblem, P) {
  return (
    k.solidSvg(k.cylinder(cx, cy, r, z, 0.9, P, 20, 0.35), { tone: "mid", crease: "faint" }) +
    glyphSvg(emblem === "circle" ? "dot" : emblem, [cx, cy, z + 0.9], r * 0.55, P, "mid")
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Comments, commits, anchors.

/** An anchor thread from a point on a panel down to a line range on a sheet, sagging a little, dots at both ends. */
export function threadPath(from, to, P, sag = 0.18) {
  const mid = [
    (from[0] + to[0]) / 2,
    (from[1] + to[1]) / 2,
    (from[2] + to[2]) / 2 - Math.abs(from[2] - to[2]) * sag,
  ];
  const points = [];
  for (let i = 0; i <= 24; i++) {
    const t = i / 24;
    const u = 1 - t;
    points.push([0, 1, 2].map((j) => u * u * from[j] + 2 * u * t * mid[j] + t * t * to[j]));
  }
  return k.pathOf(points.map((p) => k.iso(p, P)));
}

// ---------------------------------------------------------------------------------------------------------------
// The guide: upright panels facing the reader, their words as pills on the front face.

/** Rounded rect markup in a face's own flat coordinates. */
const rectOn = (x, y, w, h, tone, r = Math.min(w, h) / 2) =>
  `<rect class="dg-pill" data-tone="${tone}" x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}"/>`;

/**
 * A guide panel standing upright at `z`, facing +y, `h` tall. `kind` is "overview", "flow" or "chapter";
 * `badge` is "core" (a filled square) or "tests" (a hollow one). Returns the markup and the anchor sockets along
 * its bottom edge, as world points, for threads to drop from.
 */
export function guidePanelSvg(
  plan,
  z,
  h,
  P,
  {
    kind = "chapter",
    badge = "core",
    seed = 11,
    lit = false,
    sockets = 0,
    dim = false,
    number = 0,
    revision = 0,
  } = {},
) {
  const { x, y, w, d } = plan;
  const out = [];
  out.push(
    k.solidSvg(k.slabOf({ x, y, w, d, r: 0.6 }, z, h, P, 2, 0), {
      tone: lit ? "hi" : "hi",
      crease: "faint",
      lit,
    }),
  );
  const face = k.sideMatrix([x, y + d], z + h, P, "left");
  const random = seeded(seed);
  const c = [];
  // App chrome: a title bar with the window's dots and the revision's ref chip; the content sits under it.
  const bar = 6.4;
  const ch = h - bar;
  const body = [];
  if (kind === "chapter") {
    body.push(
      badge === "core"
        ? rectOn(5, 5.4, 4.6, 4.6, "hi", 0.6)
        : `<rect class="dg-hollow" x="5" y="5.4" width="4.6" height="4.6" rx=".6" style="stroke:var(--anatomy-hi)"/>`,
    );
    // The chapter's number, as pips: 1, 2 or 3.
    for (let i = 0; i < number; i++) body.push(rectOn(11.8 + i * 3, 6.6, 2.2, 2.2, "mid", 1.1));
    let at = 5;
    const title = [10 + random() * 8, 6 + random() * 6, 9 + random() * 8];
    for (const len of title) {
      if (at + len > w - 5) break;
      body.push(rectOn(at, 13.2, len, 2.6, lit ? "lit" : "hi"));
      at += len + 1.6;
    }
    const rows = Math.max(1, Math.floor((h - 26) / 4.2));
    for (let r = 0; r < rows; r++) {
      let ax = 5;
      const cnt = 2 + Math.floor(random() * 3);
      for (let i = 0; i < cnt; i++) {
        const len = 4 + random() * 12;
        if (ax + len > w - 5) break;
        body.push(rectOn(ax, 19.6 + r * 4.2, len, 1.6, "lo"));
        ax += len + 1.4;
      }
    }
  } else if (kind === "overview") {
    body.push(rectOn(5, 5.6, 14, 2.6, "hi"));
    for (let r = 0; r < Math.floor((h - 16) / 4.2); r++) {
      let ax = 5;
      for (let i = 0; i < 3; i++) {
        const len = 5 + random() * 11;
        if (ax + len > w - 5) break;
        body.push(rectOn(ax, 11.6 + r * 4.2, len, 1.6, "lo"));
        ax += len + 1.4;
      }
    }
  } else {
    // flow: before -> after, two small node graphs side by side.
    const half = (w - 10) / 2;
    const graph = (ox, extra) => {
      const nodes = [
        [ox + 4, 8],
        [ox + half / 2, 8],
        [ox + half - 6, 8],
        [ox + half / 2, ch - 10],
      ];
      if (extra) nodes.push([ox + half - 6, ch - 10]);
      const edges = [
        [0, 1],
        [1, 2],
        [1, 3],
      ];
      if (extra) edges.push([3, 4], [2, 4]);
      for (const [a, b] of edges)
        body.push(
          `<path class="dg-hollow" style="stroke:var(--anatomy-mid)" d="M${nodes[a][0]} ${nodes[a][1]}L${nodes[b][0]} ${nodes[b][1]}"/>`,
        );
      nodes.forEach(([nx, ny], i) => {
        const fresh = extra && i === 4;
        body.push(
          fresh
            ? rectOn(nx - 2.6, ny - 1.6, 5.2, 3.2, "hi", 0.8)
            : `<rect class="iso-fill" x="${nx - 2.6}" y="${ny - 1.6}" width="5.2" height="3.2" rx=".8"/><rect class="dg-hollow" style="stroke:var(--anatomy-hi)" x="${nx - 2.6}" y="${ny - 1.6}" width="5.2" height="3.2" rx=".8"/>`,
        );
      });
    };
    graph(5, false);
    body.push(
      `<path class="dg-hollow" style="stroke:var(--anatomy-hi)" d="M${w / 2 - 2} ${ch / 2}L${w / 2 + 2} ${ch / 2}M${w / 2 + 0.6} ${ch / 2 - 1.2}L${w / 2 + 2} ${ch / 2}L${w / 2 + 0.6} ${ch / 2 + 1.2}"/>`,
    );
    graph(w / 2 + 3, true);
  }
  c.push(UI.titleBar(w, bar, { tag: revision, dim }));
  c.push(`<g transform="translate(0 ${bar})">${body.join("")}</g>`);
  // Connector endpoints along the bottom edge, where each anchor line leaves the chapter.
  const endXs = Array.isArray(sockets)
    ? sockets
    : Array.from({ length: sockets }, (_, i) => x + w * ((i + 1) / (sockets + 1)));
  endXs.forEach((sx) => {
    c.push(`<circle class="dg-pill" data-tone="hi" cx="${sx - x}" cy="${h - 2.4}" r="1"/>`);
  });
  out.push(`<g transform="${face}">${c.join("")}</g>`);
  return {
    svg: `<g class="dg-panel${dim ? " dg-dim dg-glass" : ""}">${out.join("")}</g>`,
    sockets: endXs.map((sx) => [sx, y + d, z + 2.4]),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The agent: a terminal's block cursor.

/**
 * The block cursor: a terminal's cursor stood up as a small rose block with a soft glow, and its underline stub a
 * hair below. The beam leaves from the stub. `prompt` sizes the chevron it waits after. `id` names the glow's
 * gradient; each call gets its own by default, so several cursors on one page never share one.
 */
let cursors = 0;
export function blockCursorSvg(
  [cx, cy, cz],
  P,
  { w = 7.5, d = 3, h = 11, prompt = 2.2, id = `dg-cursor-glow-${++cursors}` } = {},
) {
  const block = k.slabOf({ x: cx - w / 2, y: cy - d / 2, w, d, r: 0.5 }, cz, h, P, 2);
  // The underline stub sits on the block's baseline just after it, as a prompt waits after the cursor.
  const stub = k.slabOf(
    { x: cx + w / 2 + 1.6, y: cy - d / 2, w: w * 0.9, d, r: 0.4 },
    cz,
    1.3,
    P,
    2,
  );
  const faces = (paths) =>
    `<path class="iso-fill" d="${paths.fill}"/>` +
    paths.shades
      .map((dd, i) => (dd ? `<path class="dg-face" data-light="${i}" d="${dd}"/>` : ""))
      .join("") +
    `<path class="dg-face" data-light="2" d="${paths.top}"/>` +
    `<path class="dg-gem-edge" d="${paths.outline}"/>`;
  const [gx, gy] = k.iso([cx, cy, cz + h / 2], P);
  const glow = `<ellipse cx="${gx.toFixed(1)}" cy="${gy.toFixed(1)}" rx="${(w * 2.6).toFixed(1)}" ry="${(h * 1.9).toFixed(1)}" fill="url(#${id})"/>`;
  return (
    `<defs><radialGradient id="${id}"><stop offset="0" class="dg-glow-core"/><stop offset="1" class="dg-glow-edge"/></radialGradient></defs>` +
    glow +
    // The prompt it waits at: a chevron on the block's front plane, just before it, as a terminal draws "› ▮_".
    `<g transform="${faceFront(cx - w / 2 - 6.4, cy + d / 2, cz + h, P)}">${UI.chevron(2.4, h * 0.55, prompt, "right", "lit")}</g>` +
    `<g class="dg-gem">${faces(stub)}${faces(block)}</g>`
  );
}

// Paths from the kit sample outlines finely. Drop the points a straight run would pass within SLIM px of, so a
// dense drawing fits the weight budget without losing a visible bend. Only plain M/L/Z paths are touched.
const SLIM = 0.15;
function thin(points, from, to, keep) {
  const [ax, ay] = points[from];
  const [bx, by] = points[to];
  const length = Math.hypot(bx - ax, by - ay);
  let far = 0;
  let index = -1;
  for (let i = from + 1; i < to; i++) {
    // An outline that comes back to where it started has no chord to measure from: split at its farthest point.
    const away = length
      ? Math.abs((bx - ax) * (ay - points[i][1]) - (ax - points[i][0]) * (by - ay)) / length
      : Math.hypot(points[i][0] - ax, points[i][1] - ay);
    if (away > far) {
      far = away;
      index = i;
    }
  }
  if (far <= SLIM) return;
  keep[index] = true;
  thin(points, from, index, keep);
  thin(points, index, to, keep);
}
function slimPath(d) {
  if (!/^[MLZ\d\s.-]+$/.test(d)) return d;
  return d
    .split(/(?=M)/)
    .map((run) => {
      const closed = run.endsWith("Z");
      const points = [...run.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((m) => [
        Number(m[1]),
        Number(m[2]),
      ]);
      if (points.length < 4) return run;
      const keep = points.map((_, i) => i === 0 || i === points.length - 1);
      thin(points, 0, points.length - 1, keep);
      return (
        points
          .filter((_, i) => keep[i])
          .map(([x, y], i) => `${i ? "L" : "M"}${x} ${y}`)
          .join("") + (closed ? "Z" : "")
      );
    })
    .join("");
}
/** Thins every plain path in a drawing's markup. */
export const slimSvg = (svg) => svg.replace(/ d="([^"]*)"/g, (_, d) => ` d="${slimPath(d)}"`);

// ---------------------------------------------------------------------------------------------------------------
// Software UI on faces. Every panel is drawn the way the app or the tool shows it (a window with a title bar, a
// list, a commit graph, a checks list, a terminal), as flat 2D markup in the panel's own units, then laid onto a
// face of the solid with the kit's face matrices. Nothing here is a physical object.

/** The matrix that lays local (u, v) onto a top face at z: u along +x, v along +y. */
export const faceTop = (x, y, z, P) => k.topMatrix([x, y], z, P, "x");
/** The matrix that lays local (u, v) onto an upright face at y facing +y, its top edge at z: u along +x, v down. */
export const faceFront = (x, y, z, P) => k.sideMatrix([x, y], z, P, "left");

const n1 = (v) => Math.round(v * 100) / 100;

/** Flat UI marks, in a face's own units. */
export const UI = {
  /** A rounded rect standing for words. */
  pill: (x, y, w, h = 2, tone = "lo") =>
    `<rect class="dg-pill" data-tone="${tone}" x="${n1(x)}" y="${n1(y)}" width="${n1(w)}" height="${n1(h)}" rx="${n1(h / 2)}"/>`,
  /** A row of word pills from `x`, centred on `y`. */
  text(x, y, lens, tone = "lo", h = 2, gap = 1.4) {
    let at = x;
    return lens
      .map((len) => {
        const mark = UI.pill(at, y - h / 2, len, h, tone);
        at += len + gap;
        return mark;
      })
      .join("");
  },
  dot: (cx, cy, r, tone = "mid") =>
    `<circle class="dg-pill" data-tone="${tone}" cx="${n1(cx)}" cy="${n1(cy)}" r="${n1(r)}"/>`,
  ring: (cx, cy, r, tone = "mid", dash = false, bold = false) =>
    `<circle class="dg-stroke" data-tone="${tone}"${dash ? " data-dash" : ""}${bold ? " data-bold" : ""} cx="${n1(cx)}" cy="${n1(cy)}" r="${n1(r)}"/>`,
  line: (points, tone = "mid", dash = false, bold = false) =>
    `<path class="dg-stroke" data-tone="${tone}"${dash ? " data-dash" : ""}${bold ? " data-bold" : ""} d="${points.map(([x, y], i) => `${i ? "L" : "M"}${n1(x)} ${n1(y)}`).join("")}"/>`,
  box: (x, y, w, h, { tone = "mid", fill = "paper", r = 1, dash = false } = {}) =>
    (fill
      ? `<rect class="dg-${fill}" x="${n1(x)}" y="${n1(y)}" width="${n1(w)}" height="${n1(h)}" rx="${n1(r)}"/>`
      : "") +
    (tone
      ? `<rect class="dg-stroke" data-tone="${tone}"${dash ? " data-dash" : ""} x="${n1(x)}" y="${n1(y)}" width="${n1(w)}" height="${n1(h)}" rx="${n1(r)}"/>`
      : ""),
  /** A check mark, as in a passed check or a ticked box. */
  check: (cx, cy, s, tone = "hi") =>
    UI.line(
      [
        [cx - s * 0.5, cy],
        [cx - s * 0.12, cy + s * 0.38],
        [cx + s * 0.55, cy - s * 0.42],
      ],
      tone,
    ),
  /** A passed check: a filled disc with a tick knocked out of it. */
  passed: (cx, cy, r) =>
    UI.dot(cx, cy, r, "hi") +
    `<path class="dg-stroke" style="stroke:var(--anatomy-top)" d="M${n1(cx - r * 0.45)} ${n1(cy)}L${n1(cx - r * 0.1)} ${n1(cy + r * 0.35)}L${n1(cx + r * 0.5)} ${n1(cy - r * 0.38)}"/>`,
  /** A pending check: a faint ring with a three-quarter arc, the way a running job spins. */
  pending: (cx, cy, r, tone = "mid") =>
    UI.ring(cx, cy, r, "faint") +
    `<path class="dg-stroke" data-tone="${tone}" d="M${n1(cx)} ${n1(cy - r)}A${r} ${r} 0 1 1 ${n1(cx - r)} ${n1(cy)}"/>`,
  /** An account's emblem: circle, square or triangle. Accounts are told apart by shape, never by colour. */
  emblem(kind, cx, cy, r, tone = "hi") {
    if (kind === "square")
      return UI.pill(cx - r * 0.8, cy - r * 0.8, r * 1.6, r * 1.6, tone).replace(
        /rx="[^"]*"/,
        'rx="0.2"',
      );
    if (kind === "triangle")
      return `<path class="dg-pill" data-tone="${tone}" d="M${n1(cx)} ${n1(cy - r)}L${n1(cx + r)} ${n1(cy + r * 0.8)}L${n1(cx - r)} ${n1(cy + r * 0.8)}Z"/>`;
    return UI.dot(cx, cy, r * 0.9, tone);
  },
  /** An avatar: a disc with its account's emblem. */
  avatar: (cx, cy, r, emblem = "circle", tone = "mid") =>
    `<circle class="dg-tint" cx="${n1(cx)}" cy="${n1(cy)}" r="${n1(r)}"/>` +
    UI.ring(cx, cy, r, tone) +
    UI.emblem(emblem, cx, cy, r * 0.5, tone),
  /** A key glyph, as a settings row shows a stored credential. */
  key: (x, y, s, tone = "hi") =>
    UI.ring(x + s * 0.3, y + s * 0.3, s * 0.3, tone) +
    UI.line(
      [
        [x + s * 0.6, y + s * 0.3],
        [x + s * 1.5, y + s * 0.3],
        [x + s * 1.5, y + s * 0.62],
      ],
      tone,
    ) +
    UI.line(
      [
        [x + s * 1.2, y + s * 0.3],
        [x + s * 1.2, y + s * 0.55],
      ],
      tone,
    ),
  chevron: (cx, cy, s, dir = "down", tone = "hi") =>
    dir === "down"
      ? UI.line(
          [
            [cx - s, cy - s * 0.5],
            [cx, cy + s * 0.5],
            [cx + s, cy - s * 0.5],
          ],
          tone,
        )
      : UI.line(
          [
            [cx - s * 0.5, cy - s],
            [cx + s * 0.5, cy],
            [cx - s * 0.5, cy + s],
          ],
          tone,
        ),
  /** A comment glyph: a speech bubble. */
  comment: (x, y, s, tone = "hi") =>
    UI.line(
      [
        [x, y],
        [x + s, y],
        [x + s, y + s * 0.7],
        [x + s * 0.45, y + s * 0.7],
        [x + s * 0.2, y + s],
        [x + s * 0.22, y + s * 0.7],
        [x, y + s * 0.7],
        [x, y],
      ],
      tone,
    ),
  arrowUp: (cx, cy, s, tone = "hi") =>
    UI.line(
      [
        [cx, cy + s],
        [cx, cy - s],
      ],
      tone,
    ) +
    UI.line(
      [
        [cx - s * 0.6, cy - s * 0.4],
        [cx, cy - s],
        [cx + s * 0.6, cy - s * 0.4],
      ],
      tone,
    ),
  folder: (x, y, s, tone = "mid") =>
    UI.line(
      [
        [x, y + s * 0.8],
        [x, y],
        [x + s * 0.4, y],
        [x + s * 0.5, y + s * 0.18],
        [x + s * 1.1, y + s * 0.18],
        [x + s * 1.1, y + s * 0.8],
        [x, y + s * 0.8],
      ],
      tone,
    ),
  file: (x, y, s, tone = "mid") =>
    UI.line(
      [
        [x, y],
        [x + s * 0.55, y],
        [x + s * 0.8, y + s * 0.25],
        [x + s * 0.8, y + s],
        [x, y + s],
        [x, y],
      ],
      tone,
    ),
  cross: (cx, cy, s, tone = "hi") =>
    UI.line(
      [
        [cx - s, cy - s],
        [cx + s, cy + s],
      ],
      tone,
    ) +
    UI.line(
      [
        [cx + s, cy - s],
        [cx - s, cy + s],
      ],
      tone,
    ),
  /** A git ref label: a tag with a pointed left end, carrying one pip per revision. */
  tag(x, y, pips, { tone = "hi", h = 3.4 } = {}) {
    const w = 3.6 + pips * (h * 0.75);
    const outline = [
      [x, y + h / 2],
      [x + 1.6, y],
      [x + w, y],
      [x + w, y + h],
      [x + 1.6, y + h],
      [x, y + h / 2],
    ];
    return (
      `<path class="dg-paper" d="${outline.map(([a, b], i) => `${i ? "L" : "M"}${n1(a)} ${n1(b)}`).join("")}Z"/>` +
      UI.line(outline, tone) +
      Array.from({ length: pips }, (_, i) =>
        UI.dot(x + 3 + h * 0.3 + i * h * 0.75, y + h / 2, h * 0.22, tone),
      ).join("")
    );
  },
  /** A button: an outlined rounded rect with its label as one pill; `primary` fills it. */
  button: (x, y, w, h, { primary = false } = {}) =>
    (primary
      ? UI.pill(x, y, w, h, "hi").replace(/rx="[^"]*"/, 'rx="1"')
      : UI.box(x, y, w, h, { tone: "hi", r: 1 })) +
    UI.pill(x + w * 0.25, y + h / 2 - 0.8, w * 0.5, 1.6, primary ? "faint" : "mid"),
  /** A window's title bar: a band with the three window dots, title pills, and a ref tag on the right. */
  titleBar(w, h = 6.4, { tag = 0, dim = false, title = [] } = {}) {
    const tone = dim ? "lo" : "mid";
    return (
      `<rect class="dg-bar" x="0.6" y="0.6" width="${n1(w - 1.2)}" height="${n1(h - 0.6)}" rx="1"/>` +
      UI.line(
        [
          [0.6, h],
          [w - 0.6, h],
        ],
        "faint",
      ) +
      [0, 1, 2].map((i) => UI.ring(3 + i * 2.6, h / 2 + 0.3, 0.8, tone)).join("") +
      (title.length ? UI.text(11, h / 2 + 0.3, title, tone, 1.6) : "") +
      (tag
        ? UI.tag(w - 5 - (3.2 + tag * 2.4), h / 2 + 0.3 - 1.6, tag, {
            tone: dim ? "lo" : "hi",
            h: 3.2,
          })
        : "")
    );
  },
};

/** A flat app panel: a thin solid with its UI laid on the top face. `body(w, d)` returns the UI under the bar. */
export function flatPanelSvg(
  plan,
  z,
  P,
  {
    h = 1.6,
    body = () => "",
    bar = 6.4,
    title = [],
    tag = 0,
    tone = "hi",
    halo = true,
    dim = false,
    dash = false,
  } = {},
) {
  const solid = k.solidSvg(k.slabOf(plan, z, h, P, 3, 0.6), { tone, crease: "faint", halo });
  const ui =
    (bar ? UI.titleBar(plan.w, bar, { tag, title, dim }) : "") +
    `<g transform="translate(0 ${bar})">${body(plan.w, plan.d - bar)}</g>`;
  const outline = dash
    ? UI.box(0.4, 0.4, plan.w - 0.8, plan.d - 0.8, { fill: "", dash: true, tone: "lo" })
    : "";
  return `<g${dim ? ' class="dg-dim"' : ""}>${solid}<g transform="${faceTop(plan.x, plan.y, z + h, P)}">${ui}${outline}</g></g>`;
}

/** An upright app panel facing +y, `height` tall from `z`: a terminal, a list, a window seen side on. */
export function uprightPanelSvg(
  plan,
  z,
  height,
  P,
  { body = () => "", bar = 6.4, title = [], tag = 0, tone = "hi", lit = false, dim = false } = {},
) {
  const solid = k.solidSvg(k.slabOf({ ...plan, r: 0.6 }, z, height, P, 2), {
    tone,
    crease: "faint",
    lit,
  });
  const ui =
    (bar ? UI.titleBar(plan.w, bar, { tag, title, dim }) : "") +
    `<g transform="translate(0 ${bar})">${body(plan.w, height - bar)}</g>`;
  return `<g${dim ? ' class="dg-dim dg-glass"' : ""}>${solid}<g transform="${faceFront(plan.x, plan.y + plan.d, z + height, P)}">${ui}</g></g>`;
}

/**
 * A commit graph the way `git log --graph` and a commits list draw it: the base line, a head line forking off it,
 * one node per commit with its short SHA and message as pills, and ref tags on the commits they name. `fresh` is
 * the index of a head commit that has just been appended: its row is highlighted and its node ringed. With `part`,
 * the fresh commit, with its stretch of the head line, is one group (`<part>-fresh`) and each ref tag another
 * (`<part>-ref-<i>`, drawn over the commits; `hidden` starts it at opacity 0), so a page can append the commit, then
 * tag it once its revision is accepted, and dim an older tag.
 */
export function commitGraphUi(
  w,
  d,
  { base = 2, head = 4, fresh = -1, refs = {}, seed = 9, remote = -1, part = "" } = {},
) {
  const random = seeded(seed);
  const out = [];
  const by = d * 0.32;
  const hy = d * 0.7;
  const step = (w - 40) / (base + head);
  const bx = (i) => 6 + i * step;
  const hx = (i) => 6 + (base + i) * step;
  const forkAt = bx(base - 1);
  // With `part`, the newest commit is drawn apart so a page can append it; its tint stays under the lines.
  const apart = part && fresh === head - 1;
  const group = (markup) => `<g data-part="${part}-fresh">${markup}</g>`;
  const tint =
    fresh >= 0
      ? `<rect class="dg-tint" x="${n1(hx(fresh) - step * 0.45)}" y="1" width="${n1(step * 0.9)}" height="${n1(d - 2)}" rx="1.2"/>`
      : "";
  if (tint) out.push(apart ? group(tint) : tint);
  out.push(
    UI.line(
      [
        [4, by],
        [w - 6, by],
      ],
      "mid",
      false,
      true,
    ),
  );
  out.push(
    UI.line(
      [
        [forkAt, by],
        [forkAt + step * 0.4, hy],
        [hx(apart ? head - 2 : head - 1), hy],
      ],
      "hi",
      false,
      true,
    ),
  );
  for (let i = 0; i < base; i++) {
    out.push(UI.dot(bx(i), by, 2, "mid"), UI.text(bx(i) + 4, by - 0.2, [8, 10], "lo", 1.8));
  }
  const later = [];
  for (let i = 0; i < head; i++) {
    const x = hx(i);
    const own = [];
    if (apart && i === fresh)
      own.push(
        UI.line(
          [
            [hx(i - 1), hy],
            [x, hy],
          ],
          "hi",
          false,
          true,
        ),
      );
    if (i === fresh) own.push(UI.ring(x, hy, 4.2, "hi", false, true));
    own.push(
      `<circle class="dg-paper" cx="${n1(x)}" cy="${n1(hy)}" r="2.6"/>`,
      UI.ring(x, hy, 2.6, "hi", false, true),
      UI.dot(x, hy, 1.2, "hi"),
    );
    own.push(
      UI.text(x - 4, hy + 6, [8], "mid", 1.8),
      UI.text(x + 5, hy - 0.2, [6 + random() * 8], "lo", 1.8),
    );
    if (refs[i]) {
      const tag = UI.tag(x - 3, hy - 11, refs[i].pips, {
        tone: refs[i].dim ? "lo" : "hi",
        h: 4.2,
      });
      // A ref tag is its own part, outside the fresh commit, so a page can show it after the commit lands.
      if (part)
        later.push(
          `<g data-part="${part}-ref-${i}"${refs[i].hidden ? ' opacity="0"' : ""}>${tag}</g>`,
        );
      else own.push(tag);
    }
    out.push(apart && i === fresh ? group(own.join("")) : own.join(""));
  }
  out.push(...later);
  if (remote >= 0) out.push(UI.ring(hx(remote), hy, 4.2, "lo", true));
  return out.join("");
}

/**
 * A checks list, CI style: one row per check, its state icon, its name as pills. `rows` holds "pass" or "pending".
 * With `part`, each row carries both icons, the hidden one at opacity 0, as `<part>-<i>-pass` and `<part>-<i>-pending`.
 */
export function checksUi(w, rows, { seed = 5, part = "" } = {}) {
  const random = seeded(seed);
  return rows
    .map((state, i) => {
      const cy = 5.6 + i * 8;
      const pass = UI.passed(5.6, cy, 2.8);
      const pending = UI.pending(5.6, cy, 2.6);
      const shown = (name, markup) =>
        `<g data-part="${part}-${i}-${name}"${name === state ? "" : ' opacity="0"'}>${markup}</g>`;
      const icon = part
        ? shown("pass", pass) + shown("pending", pending)
        : state === "pass"
          ? pass
          : pending;
      return (
        (i
          ? UI.line(
              [
                [2, cy - 4],
                [w - 2, cy - 4],
              ],
              "faint",
            )
          : "") +
        icon +
        UI.text(11.4, cy, [10 + random() * 8, 5 + random() * 6], state === "pass" ? "mid" : "lo", 2)
      );
    })
    .join("");
}

/** A terminal session: prompt lines as a chevron and pills, then the live prompt where the cursor waits. */
export function terminalUi(w, h, { lines = 4, seed = 3, cursor = true } = {}) {
  const random = seeded(seed);
  const out = [
    `<rect class="dg-tint" x="1" y="1" width="${n1(w - 2)}" height="${n1(h - 2)}" rx="1"/>`,
  ];
  for (let i = 0; i < lines; i++) {
    const cy = 5 + i * 4.4;
    const prompt = i % 2 === 0;
    if (prompt) out.push(UI.chevron(4, cy, 0.9, "right", "mid"));
    out.push(
      UI.text(
        prompt ? 7 : 4,
        cy,
        [4 + random() * 8, 3 + random() * 10],
        prompt ? "mid" : "lo",
        1.5,
      ),
    );
  }
  const cy = 5 + lines * 4.4;
  out.push(UI.chevron(4, cy, 0.9, "right", "hi"));
  if (cursor)
    out.push(
      `<rect class="dg-lit-fill" x="7" y="${n1(cy - 1.6)}" width="2.4" height="3.2" rx=".3"/>`,
      `<rect class="dg-lit-fill" x="10.2" y="${n1(cy + 1)}" width="2.4" height=".6"/>`,
    );
  return out.join("");
}

/**
 * A review comment thread as a diff viewer shows it inline: a card with the author's avatar and words, replies
 * indented under it, and a selection box when it is picked for a batch.
 */
export function threadUi(
  x,
  y,
  w,
  { replies = 1, emblem = "circle", selected = false, seed = 4 } = {},
) {
  const random = seeded(seed);
  const h = 8 + replies * 6;
  const out = [UI.box(x, y, w, h, { tone: selected ? "hi" : "mid", r: 1 })];
  out.push(
    UI.avatar(x + 4, y + 4, 2, emblem),
    UI.text(x + 7.6, y + 4, [6 + random() * 5, 4], "mid", 1.5),
  );
  for (let i = 0; i < replies; i++) {
    const ry = y + 9 + i * 6;
    out.push(
      UI.line(
        [
          [x + 4, y + 6.4],
          [x + 4, ry + 1.4],
          [x + 6, ry + 1.4],
        ],
        "faint",
      ),
      UI.text(x + 7.6, ry + 1.4, [8 + random() * 8, 5 + random() * 6], "lo", 1.4),
    );
  }
  out.push(
    UI.box(x + w - 5, y + 2.2, 3.2, 3.2, { tone: "hi", fill: selected ? "" : "paper", r: 0.5 }),
  );
  if (selected)
    out.push(
      `<rect class="dg-pill" data-tone="hi" x="${n1(x + w - 5)}" y="${n1(y + 2.2)}" width="3.2" height="3.2" rx=".5"/>`,
      `<path class="dg-stroke" style="stroke:var(--anatomy-top)" d="M${n1(x + w - 4.3)} ${n1(y + 3.8)}L${n1(x + w - 3.5)} ${n1(y + 4.6)}L${n1(x + w - 2.4)} ${n1(y + 2.9)}"/>`,
    );
  return { svg: out.join(""), h };
}

/** A connector line between two world points, as a diagram draws it, with an endpoint dot at each end. */
export function connectorSvg(from, to, P, { tone = "mid", sag = 0.08 } = {}) {
  return (
    k.lineSvg(threadPath(from, to, P, sag), { tone }) +
    k.dotsSvg([k.iso(from, P), k.iso(to, P)], { size: 0.9, tone: "hi" })
  );
}
