// The truth behind the stack figure. Every count it draws and every step of its tour come from here, as pure
// functions of time.
//
// What it stands for (docs/internals/architecture.md "Stacks" and "Concurrency", WhatItDoes.astro):
// - A stack's layers are pull requests, numbered from the bottom. Each one targets the branch of the layer below,
//   and the bottom one targets the trunk. The inbox row says "Stack 2/3".
// - Under the PR header a strip lists the layers with their guide: none, writing or ready.
// - Whole stack starts one guide per open layer, bottom to top, with one agent, under the app's two agent slots:
//   a third layer waits until a slot frees up.
// - Each guide covers only its own layer's diff and writes other layers as #123.

/**
 * A three-layer stack on main, all of it open, the size of the app's own stack screenshot ("Stack 2/3", layer 2
 * one file, +10 -0). Each file lists its removed and added lines.
 */
export const LAYERS = [
  {
    files: [
      { added: 6, removed: 2 },
      { added: 3, removed: 0 },
    ],
  },
  { files: [{ added: 10, removed: 0 }] },
  {
    files: [
      { added: 4, removed: 1 },
      { added: 2, removed: 1 },
    ],
  },
];

/** At most two agent processes run at once, across the app (`Agents.slots`). */
export const SLOTS = 2;

/** The layer the guides are started from, and the one the figure rests on: layer 2, as in the screenshot. */
export const HOME = 1;

/** The rows of guide text each panel writes, one at a time. */
export const GUIDE_ROWS = 5;

/**
 * The pace of the whole tour: every span below is scaled by it together, so the frame the figure rests on stays
 * the same picture.
 */
const PACE = 2 / 3;

/** How long the agent takes on each layer's guide, in seconds: longer for a bigger diff. */
const WRITE = LAYERS.map(
  (layer) =>
    (2 + 0.16 * layer.files.reduce((sum, file) => sum + file.added + file.removed, 0)) * PACE,
);

/** A diff's rows as a diff viewer lists them: per file a header, a line of context, the removed, the added. */
export function rowsOf(layer) {
  return LAYERS[layer].files.flatMap((file) => [
    "file",
    "ctx",
    ...Array.from({ length: file.removed }, () => "del"),
    ...Array.from({ length: file.added }, () => "add"),
  ]);
}

/**
 * When each layer's guide starts and ends, counted from the click: started bottom to top, each taking the first
 * free slot. Two run at once, so layer 3 waits for layer 1.
 */
export const SCHEDULE = (() => {
  const free = Array.from({ length: SLOTS }, () => 0);
  return LAYERS.map((_, layer) => {
    const slot = free.indexOf(Math.min(...free));
    // Started in order, a beat apart, as the batch starts them one by one.
    const start = Math.max(free[slot], layer * 0.35 * PACE);
    free[slot] = start + WRITE[layer];
    return { start, end: start + WRITE[layer] };
  });
})();

const WRITTEN = Math.max(...SCHEDULE.map((entry) => entry.end));

// The tour: a fresh stack, Whole stack, then each layer in turn, then home.
const BATCH_AT = 1 * PACE;
const VISITS_AT = BATCH_AT + WRITTEN + 0.9 * PACE;
const VISIT = 2.4 * PACE;
const HOME_AT = VISITS_AT + LAYERS.length * VISIT;
const CLEAR_AT = HOME_AT + 2.6 * PACE;
const CLEAR = 0.8 * PACE;
export const LOOP = CLEAR_AT + CLEAR + 0.6 * PACE;

/** Where Whole stack restarts the tour: the guides cleared, just before the batch starts. */
export const BATCH_START = BATCH_AT - 0.4 * PACE;

/** The frame the figure rests on: layers 1 and 2 have their guides, the agent is writing layer 3's. */
export const T_STILL = BATCH_AT + (SCHEDULE[1].end + SCHEDULE[2].end) / 2;

/** The end of the batch, every guide written, on the home layer: where reduced motion lands after Whole stack. */
export const T_WRITTEN = VISITS_AT - 0.2 * PACE;

const clamp01 = (value) => Math.min(1, Math.max(0, value));
/** Smootherstep: zero velocity and acceleration at both ends. */
export const ease = (value) => {
  const u = clamp01(value);
  return u * u * u * (u * (u * 6 - 15) + 10);
};

/**
 * Each guide at tour time `time`: its state ("none", "queued", "writing" or "ready"), how much of it is written
 * (0 to 1), and how present it is (0 cleared, 1 shown), plus the layer you're on.
 */
export function stateAt(time) {
  const t = ((time % LOOP) + LOOP) % LOOP;
  const since = t - BATCH_AT;
  const shown = 1 - ease((t - CLEAR_AT) / CLEAR);
  const guides = SCHEDULE.map(({ start, end }) => {
    if (since < 0 || t >= CLEAR_AT + CLEAR) return { state: "none", written: 0, shown: 1 };
    if (since < start) return { state: "queued", written: 0, shown: 1 };
    if (since < end)
      return { state: "writing", written: (since - start) / (end - start), shown: 1 };
    return { state: "ready", written: 1, shown };
  });
  let on = HOME;
  if (t >= VISITS_AT && t < HOME_AT) on = Math.floor((t - VISITS_AT) / VISIT);
  // During the visits one layer is picked; otherwise the whole stack is in view.
  const picked = t >= VISITS_AT && t < HOME_AT + 1.2 * PACE;
  return { guides, on, picked };
}
