/**
 * The small square marks beside "What it does": five tiny objects drawn with the anatomy kit at
 * build time, in the figures' camera and tones, each with one lit part. They are decoration (the
 * rows say everything in words), so they carry no accessible name.
 */
import * as k from "../figures/kit/iso-kit.mjs";

const SIZE = 120;

/** A camera fitted to one object's box, and the kit's renderers bound to it. */
function kitFor(plan, z0, z1) {
  const P = k.fitProjection(k.boxCorners(plan, z0, z1), SIZE, SIZE, { pad: 9 });
  return {
    P,
    at: (point) => k.iso(point, P),
    S: (paths, style) => k.solidSvg(paths, style),
    L: (d, style) => k.lineSvg(d, style),
    halo: (box, z = 0) =>
      `<path class="iso-halo" d="${k.haloOf(box, z - 1, 1, P)}" style="filter:blur(3px)"/>`,
  };
}

const svg = (body) =>
  `<svg class="iso-svg" viewBox="0 0 ${SIZE} ${SIZE}" aria-hidden="true" focusable="false">${body.join("")}</svg>`;

/** A shallow letter tray with three cards in it; the top card is the one that needs you. */
function inbox() {
  const tray = { x: -28, y: -22, w: 56, d: 44, r: 3 };
  const { P, S, halo } = kitFor(tray, 0, 10);
  const wall = 7;
  const out = [halo(tray), S(k.slabOf(tray, 0, 3, P, 4, 0.5), { tone: "mid" })];
  out.push(
    S(k.slabOf({ x: tray.x, y: tray.y, w: tray.w, d: 3, r: 1 }, 3, wall, P, 3), { tone: "mid" }),
  );
  out.push(
    S(k.slabOf({ x: tray.x, y: tray.y, w: 3, d: tray.d, r: 1 }, 3, wall, P, 3), { tone: "mid" }),
  );
  [0, 1, 2].forEach((index) => {
    const card = { x: -21 + index * 2.5, y: -16 + index, w: 40, d: 30, r: 1.2 };
    const z = 3 + index * 2.2;
    const top = index === 2;
    out.push(S(k.slabOf(card, z, 1.6, P, 3), { tone: top ? "hi" : "mid", lit: top }));
    if (top) {
      const lines = [0, 1, 2].map((row) =>
        k.lineOnTop(
          [card.x + 5, card.y + 8 + row * 5],
          [card.x + (row ? 24 : 16), card.y + 8 + row * 5],
          z + 1.6,
          P,
        ),
      );
      out.push(k.lineSvg(lines.join(""), { tone: "lo", free: true }));
    }
  });
  out.push(
    S(k.slabOf({ x: tray.x + tray.w - 3, y: tray.y, w: 3, d: tray.d, r: 1 }, 3, wall, P, 3), {
      tone: "mid",
    }),
  );
  out.push(
    S(k.slabOf({ x: tray.x, y: tray.y + tray.d - 3, w: tray.w, d: 3, r: 1 }, 3, wall - 3, P, 3), {
      tone: "mid",
    }),
  );
  return svg(out);
}

/** Three pages of a guide; on the top one the first chapter, the core change, is lit. */
function guide() {
  const { P, S, L, halo } = kitFor({ x: -27, y: -21, w: 52, d: 43 }, 0, 9);
  const out = [halo({ x: -27, y: -21, w: 52, d: 43, r: 2 })];
  [0, 1, 2].forEach((index) => {
    const page = { x: -27 + index * 3, y: -21 + index * 1.5, w: 46, d: 40, r: 1.5 };
    const z = index * 2.2;
    out.push(S(k.slabOf(page, z, 2.2, P, 3), { tone: index === 2 ? "hi" : "mid" }));
    if (index === 2) {
      const top = z + 2.2;
      const row = (y, length) =>
        k.lineOnTop([page.x + 6, page.y + y], [page.x + 6 + length, page.y + y], top, P);
      out.push(L(row(7, 20), { tone: "hi", free: true }));
      out.push(L(row(14, 30), { tone: "lit", free: true }));
      out.push(L([row(20, 26), row(26, 32), row(32, 22)].join(""), { tone: "lo", free: true }));
    }
  });
  return svg(out);
}

/** A dial gauge on its back, keeping watch: the needle is lit. */
function watching() {
  const [x, y] = [0, 0];
  const radius = 25;
  const { P, S, L, halo } = kitFor(
    { x: -radius, y: -radius - 5, w: radius * 2, d: radius * 2 + 5 },
    0,
    9,
  );
  const out = [halo({ x: -radius, y: -radius, w: radius * 2, d: radius * 2, r: radius })];
  out.push(S(k.cylinder(x, y - radius - 2, 3.2, 2.5, 5, P, 16), { tone: "mid" }));
  out.push(S(k.cylinder(x, y, radius, 0, 9, P, 64, 0.8), { tone: "hi", crease: "lo" }));
  out.push(L(k.ring(x, y, radius - 3, 9, P, 64), { tone: "lo" }));
  const ticks = k.radialTicks(x, y, radius - 4, 40, 5, 9, [1.6, 3.4], P);
  out.push(L(ticks.minor, { tone: "lo" }), L(ticks.major, { tone: "mid" }));
  const angle = 0.95;
  // The needle runs through the pivot and stops at its far rim; only the tip is free.
  const pivot = 1.8;
  out.push(
    `<path class="iso-line" data-tone="lit" data-free="end" d="${k.lineOnTop([x - Math.sin(angle) * pivot, y + Math.cos(angle) * pivot], [x + Math.sin(angle) * (radius - 7), y - Math.cos(angle) * (radius - 7)], 9.2, P)}" style="stroke-width:1.2"/>`,
  );
  out.push(L(k.ring(x, y, pivot, 9.2, P, 16), { tone: "hi" }));
  return svg(out);
}

/** A branch and its copy, joined by a dotted line; the copy carries the fix, lit. */
function fixes() {
  const left = { x: -32, y: -16, w: 26, d: 32, r: 2 };
  const right = { x: 6, y: -16, w: 26, d: 32, r: 2 };
  const height = 6;
  const { P, at, S, L, halo } = kitFor({ x: -32, y: -16, w: 64, d: 32 }, 0, 8);
  const out = [halo(left), halo(right)];
  for (const [plan, tone] of [
    [left, "mid"],
    [right, "hi"],
  ]) {
    out.push(S(k.slabOf(plan, 0, height, P, 4, 0.5), { tone }));
    const rows = [6, 11, 21, 26].map((row) =>
      k.lineOnTop([plan.x + 4, plan.y + row], [plan.x + plan.w - 6, plan.y + row], height, P),
    );
    out.push(L(rows.join(""), { tone: "lo", free: true }));
  }
  out.push(
    S(
      k.slabOf({ x: right.x + 4, y: right.y + 14, w: right.w - 8, d: 4.5, r: 1 }, height, 1, P, 3),
      { tone: "hi", lit: true },
    ),
  );
  out.push(
    k.wireSvg(at([left.x + left.w - 3, 0, height]), at([right.x + 3, 0, height]), {
      tone: "mid",
      dotted: true,
      size: 1,
    }),
  );
  return svg(out);
}

/** A stack of three layers on posts, numbered from the bottom; the middle one is lit. */
function stack() {
  const plan = { x: -22, y: -22, w: 44, d: 44, r: 3 };
  const thick = 5;
  const gap = 6;
  const { P, S, L, halo } = kitFor(plan, 0, 3 * thick + 2 * gap);
  const posts = k
    .corners(plan, 4)
    .sort((a, b) => k.depthOf([a[0], a[1], 0], P) - k.depthOf([b[0], b[1], 0], P));
  const out = [halo(plan)];
  [0, 1, 2].forEach((index) => {
    const z = index * (thick + gap);
    if (index > 0) {
      for (const [px, py] of posts) {
        out.push(S(k.cylinder(px, py, 1.4, z - gap, gap, P, 12), { tone: "lo", crease: "none" }));
      }
    }
    const lit = index === 1;
    out.push(S(k.slabOf(plan, z, thick, P, 4, 0.5), { tone: lit ? "hi" : "mid", lit }));
    out.push(L(k.planOutline(k.insetPlan(plan, 4), z + thick, P, 3), { tone: "faint" }));
  });
  return svg(out);
}

export const tiles = { inbox, guide, watching, fixes, stack };
