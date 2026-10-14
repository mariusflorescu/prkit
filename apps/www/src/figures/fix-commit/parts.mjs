// How each named part of the fix figure looks in a state from model.mjs: its opacity, and for the few that move,
// a transform. The build draws the ready state with it, and live.js writes every frame with it, so both agree.
import { translateAlong } from "../kit/iso-kit.mjs";
import { THREADS } from "./model.mjs";
import { GRAPH, P, TERM_PITCH } from "./view.mjs";

const clamp01 = (value) => Math.min(1, Math.max(0, value));
const STATUSES = ["queued", "working", "ready", "pushing", "pushed"];
/** A dash runs the whole line: its offset goes from before the start to past the end (pathLength is 2). */
const DASH = 0.16;
export const dashAt = (share) => String(Math.round((DASH - share * (2 + DASH)) * 1000) / 1000);

export function partsOf(state) {
  const parts = {};
  const set = (part, opacity, more = {}) => {
    parts[part] = { opacity: Math.round(clamp01(opacity) * 1000) / 1000, ...more };
  };
  const round = state.fade;
  THREADS.forEach((_, i) => {
    set(`tick-${i}`, state.picked[i] * round);
    set(
      `send-line-${i}`,
      state.picked[i] * (0.32 + 0.68 * Math.max(state.sent, state.send > 0 ? 1 : 0)) * round,
    );
    set(`send-pulse-${i}`, state.send > 0 ? 1 : 0, { dash: dashAt(state.send) });
    const started = state.editing[i] > 0 || state.edited[i] > 0 ? 1 : 0;
    set(`term-edit-${i}`, started * round);
    set(`edit-${i}`, state.edited[i] * round);
    set(`editing-${i}`, (state.editing[i] > 0 ? 1 : 0) * (1 - state.edited[i]));
    set(`reach-${i}`, Math.min(1, state.editing[i] * 10) * (1 - state.edited[i]));
    set(`report-wait-${i}`, 1 - state.reported[i] * round);
    set(`report-done-${i}`, state.reported[i] * round);
    set(`report-note-${i}`, state.reported[i] * round);
  });
  set("term-batch", state.turn * round);
  set("term-idle", 1 - state.turn * round);
  set("term-report", state.reported[0] * round);
  // The cursor waits on the idle prompt, then sits under the last line the agent wrote.
  const lines =
    (state.turn > 0.5 ? 1 : 0) +
    THREADS.filter((_, i) => state.editing[i] > 0 || state.edited[i] > 0).length +
    (state.reported[0] > 0.5 ? 1 : 0);
  const slot = 2 + Math.round(lines * round);
  parts["term-cursor"] = { transform: `translate(0 ${Math.round(slot * TERM_PITCH * 100) / 100})` };
  STATUSES.forEach((name) => set(`status-${name}`, state.status === name ? round : 0));
  set("commit-line", state.commit * round);
  set("fresh", state.commit * round);
  set("commit-link", state.commit * (1 - state.remote) * round);
  set("ahead", state.commit * (1 - state.remote) * round);
  set("synced", state.remote * round);
  const { nodes, fresh, head } = GRAPH;
  parts.remote = {
    opacity: Math.round(clamp01(round) * 1000) / 1000,
    transform: `translate(${Math.round((nodes[2] + (fresh - nodes[2]) * state.remote) * 100) / 100} ${head})`,
  };
  set("push", state.ready ? 1 : 0.42);
  parts["push-key"] = {
    transform: state.press > 0 ? translateAlong(P, [0, 0, -0.8 * state.press]) : "",
  };
  set("token-pulse", state.token > 0 ? 1 : 0, { dash: dashAt(state.token) });
  return parts;
}
