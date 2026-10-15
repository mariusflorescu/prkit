// The truth behind the local-first figure. Every step of its tour comes from here, as pure functions of time.
//
// What it stands for (LocalFirst.astro, Faq.astro, docs/internals/architecture.md "Accounts", "Repository
// access" and "The fix agent"):
// - prkit asks gh for each account's token and keeps it in the server's memory. It never writes one to disk, and
//   only GitHub sees it: each request goes through the account that found the pull request.
// - The agent runs on your Mac under your own Claude, Codex or Cursor login. It works on its own copy, its commands carry
//   no GitHub token and have no network, and it never gets your GitHub token. (It does get its own per-turn token
//   for prkit's MCP server, and prkit's folder may link to Codex's own login: neither is a GitHub token.)
// - There is no prkit account and no prkit cloud: the app talks to GitHub and to your agent, and nothing else.

/** The accounts the figure shows, told apart by shape: one token each, all in memory. */
export const ACCOUNTS = ["circle", "square", "triangle"];

/** The tour's steps, each a span of seconds, and the share of it a pick shows. */
export const STEPS = [
  { name: "github", from: 0.55, to: 2.95, hold: 0.5 },
  { name: "agent", from: 3.45, to: 6.4, hold: 0.55 },
  { name: "disk", from: 6.95, to: 8.8, hold: 0.85 },
];
export const LOOP = 10;

const clamp01 = (value) => Math.min(1, Math.max(0, value));
/** Smootherstep: zero velocity and acceleration at both ends. */
export const ease = (value) => {
  const u = clamp01(value);
  return u * u * u * (u * (u * 6 - 15) + 10);
};

/**
 * The figure at tour time `time`: the step playing (or null) and how far through it is (0 to 1).
 * `account` is the account whose token this pass's request carries. Within a step, the first 40% carries the
 * request out, the middle 20% is the far end at work, and the last 40% brings the answer back.
 */
export function tourAt(time) {
  const t = ((time % LOOP) + LOOP) % LOOP;
  const step = STEPS.find((entry) => t >= entry.from && t < entry.to) ?? null;
  const at = step ? (t - step.from) / (step.to - step.from) : 0;
  // Each pass of the tour sends its request through the next account's token.
  const account = Math.floor(Math.max(0, time) / LOOP) % ACCOUNTS.length;
  return { step: step?.name ?? null, at, account };
}

/** Where a pulse is along its line at step progress `at`: out, held at the far end, back. Null when none moves. */
export function tripOf(at) {
  if (at < 0.4) return { along: ease(at / 0.4), out: true };
  if (at < 0.6) return { along: 1, out: true, there: true };
  if (at < 1) return { along: 1 - ease((at - 0.6) / 0.4), out: false };
  return null;
}

/** The moment each step is shown at when the reader picks it: the far end at work, or the search's answer. */
export const HOLD = Object.fromEntries(
  STEPS.map((step) => [step.name, step.from + (step.to - step.from) * step.hold]),
);
