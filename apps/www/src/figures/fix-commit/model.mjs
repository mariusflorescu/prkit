// The truth behind the fix figure. Every state the figure shows comes from here, as a pure function of time.
//
// What it stands for (docs/internals/fix-agent.md, "Sessions and turns", "The checkout", "Push"; apps/web/src/
// features/fixes/):
// - You pick review comments, your drafts or a reviewer's threads, and send them to your agent as one batch. One
//   batch is one turn.
// - The agent works in its own checkout of the branch, edits a line for each comment and reports each one as
//   fixed, partly fixed or skipped (FixReportList.tsx).
// - prkit, never the agent, makes the commit: one commit per turn. The turn is then "Ready to review" with the
//   commit, the diff, and Push, Ask the agent to change, Copy patch and Discard (FixTurnCard.tsx,
//   FixTurnActions.tsx). The local branch is one commit ahead of GitHub's.
// - The agent's environment is an allowlist without a token (packages/contracts/src/childEnv.ts); prkit keeps the
//   account's token and uses it to push. Nothing reaches GitHub until you push: pushing automatically is a
//   per-repository setting, off by default.

/** The two review threads in the batch, and the line of the file each one is about. */
export const THREADS = [
  { row: 3, replies: 1, emblem: "circle" },
  { row: 9, replies: 0, emblem: "square" },
];

const clamp01 = (value) => Math.min(1, Math.max(0, value));
/** Smootherstep: zero speed and acceleration at both ends, so nothing jerks into motion. */
export const ease = (value) => {
  const u = clamp01(value);
  return u * u * u * (u * (u * 6 - 15) + 10);
};
const span = (t, from, to) => ease((t - from) / (to - from));

/** The tour's beats, in seconds, in the order things happen. */
export const BEATS = {
  pick: [0.6, 1.05],
  send: [1.35, 2.0],
  turn: [2.0, 2.55],
  edit: [
    [2.6, 3.45],
    [3.6, 4.45],
  ],
  report: [4.6, 5.05],
  commit: [5.25, 5.7],
  ready: 5.9,
};

/** The reader's push, in seconds from the click. */
export const PUSH = {
  press: 0.16,
  token: [0.13, 0.56],
  remote: [0.56, 1.06],
  clear: [2.1, 2.5],
};
export const PUSH_LENGTH = PUSH.clear[1];
/** After a push the next round fades in from the start, with a fresh pair of comments, and the tour plays again. */
export const AFTER_PUSH = -0.4;

/**
 * The figure at tour time t (0 to BEATS.ready; below 0 it fades back in after a push). The tour stops at "ready":
 * it never pushes by itself.
 */
export function tourAt(time) {
  const t = Math.min(time, BEATS.ready);
  const picked = [
    span(t, BEATS.pick[0], BEATS.pick[0] + 0.17),
    span(t, BEATS.pick[1], BEATS.pick[1] + 0.17),
  ];
  const send = clamp01((t - BEATS.send[0]) / (BEATS.send[1] - BEATS.send[0]));
  const turn = span(t, ...BEATS.turn);
  const editing = BEATS.edit.map(([from, to]) => {
    const u = clamp01((t - from) / (to - from));
    return t >= from && t < to ? u : 0;
  });
  const edited = BEATS.edit.map(([, to]) => span(t, to - 0.17, to + 0.07));
  const reported = [
    span(t, BEATS.report[0], BEATS.report[0] + 0.2),
    span(t, BEATS.report[0] + 0.23, BEATS.report[1]),
  ];
  const commit = span(t, ...BEATS.commit);
  const status =
    commit >= 1 ? "ready" : turn > 0 ? "working" : t >= BEATS.send[0] ? "queued" : "none";
  return {
    picked,
    send: t >= BEATS.send[0] && t < BEATS.send[1] ? send : 0,
    sent: t >= BEATS.send[1] ? 1 : 0,
    turn,
    editing,
    edited,
    reported,
    commit,
    status,
    ready: time >= BEATS.ready,
    press: 0,
    token: 0,
    remote: 0,
    pushed: false,
    fade: time < 0 ? span(time, AFTER_PUSH, 0) : 1,
  };
}

/** The reader's push, p seconds after the click, from the ready state. */
export function pushAt(p) {
  const ready = tourAt(BEATS.ready);
  const pushed = p >= PUSH.remote[1];
  const tokenAt = clamp01((p - PUSH.token[0]) / (PUSH.token[1] - PUSH.token[0]));
  return {
    ...ready,
    ready: false,
    press: p < PUSH.press ? ease(p / PUSH.press) : 1 - span(p, PUSH.press, PUSH.press + 0.2),
    token: p >= PUSH.token[0] && p < PUSH.token[1] ? tokenAt : 0,
    remote: span(p, ...PUSH.remote),
    pushed,
    status: pushed ? "pushed" : "pushing",
    fade: 1 - span(p, ...PUSH.clear),
  };
}

/** The figure at rest, and with no motion: the batch fixed and committed, waiting for Push. */
export const READY = tourAt(BEATS.ready);
