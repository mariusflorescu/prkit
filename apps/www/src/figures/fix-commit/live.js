// The fix figure, live: the tour picks the two threads, sends them as one batch, lets the agent write its two edits
// into its copy, has prkit make the commit, then waits at Push for as long as it takes. Only the reader's Push (the
// button under the drawing, or a click on the drawn one) sends the commit. It writes attributes on the drawing's
// parts and never re-renders; it runs only while the figure is on screen. Under reduced motion it shows the turn
// ready to push and snaps straight to pushed. Missing parts leave it still; cleanup puts back every attribute.
import { AFTER_PUSH, BEATS, PUSH, PUSH_LENGTH, READY, pushAt, tourAt } from "./model.mjs";
import { partsOf } from "./parts.mjs";

const PUSHED = pushAt(PUSH.remote[1]);

export function mount(root) {
  const svg = root.querySelector("svg");
  const button = root.querySelector("button[data-push]");
  const hit = root.querySelector('[data-part="push-hit"]');
  if (!svg || !button || !hit) return () => {};
  const nodes = new Map(
    Object.keys(partsOf(READY)).map((name) => [name, svg.querySelector(`[data-part="${name}"]`)]),
  );
  if ([...nodes.values()].some((node) => !node)) return () => {};
  // The new lines' pills, in typing order, per edit.
  const typing = [0, 1].map((edit) =>
    Array.from(svg.querySelectorAll(`[data-part^="type-${edit}-"]`)),
  );

  const still = matchMedia("(prefers-reduced-motion: reduce)");
  const original = new Map();
  const write = (node, name, value) => {
    const now = node.getAttribute(name);
    if (now === value) return;
    const seen = original.get(node) ?? new Map();
    if (!seen.has(name)) seen.set(name, now);
    original.set(node, seen);
    if (value === null || value === "") node.removeAttribute(name);
    else node.setAttribute(name, value);
  };

  let mode = still.matches ? "ready" : "tour";
  let clock = 0;
  let pushed = 0;
  let visible = false;
  let frame = 0;
  let last = 0;

  const stateNow = () => {
    if (mode === "push") return pushAt(pushed);
    if (mode === "done") return PUSHED;
    if (mode === "ready") return READY;
    return tourAt(clock);
  };
  const canPush = () => mode === "ready" || (mode === "tour" && clock >= BEATS.ready);

  function draw() {
    const state = stateNow();
    for (const [name, look] of Object.entries(partsOf(state))) {
      const node = nodes.get(name);
      if (look.opacity !== undefined)
        write(node, "opacity", look.opacity >= 1 ? null : String(look.opacity));
      if (look.transform !== undefined) write(node, "transform", look.transform || null);
      if (look.dash !== undefined) write(node, "stroke-dashoffset", look.dash);
    }
    typing.forEach((pills, edit) => {
      const share = state.editing[edit] * (pills.length + 1);
      pills.forEach((pill, j) =>
        write(pill, "opacity", String(Math.min(1, Math.max(0, share - j)).toFixed(2))),
      );
    });
    // aria-disabled, not disabled: the button keeps its focus through a push and back.
    write(button, "aria-disabled", String(!canPush()));
  }

  function tick(now) {
    const dt = last ? Math.min((now - last) / 1000, 1 / 30) : 1 / 60;
    last = now;
    if (mode === "tour") clock = Math.min(clock + dt, BEATS.ready);
    if (mode === "push") {
      pushed += dt;
      if (pushed >= PUSH_LENGTH) {
        mode = "tour";
        clock = AFTER_PUSH;
      }
    }
    draw();
    const settled = mode !== "push" && (mode !== "tour" || clock >= BEATS.ready);
    frame = visible && !settled ? requestAnimationFrame(tick) : 0;
    if (!frame) last = 0;
  }
  function run() {
    if (still.matches) {
      draw();
      return;
    }
    if (!frame && visible) frame = requestAnimationFrame(tick);
  }

  function push() {
    if (!canPush()) return;
    if (still.matches) {
      mode = "done";
      draw();
      return;
    }
    mode = "push";
    pushed = 0;
    run();
  }

  const onMotion = () => {
    if (still.matches) {
      // A push under way lands where it would have, and the tour stops where Push can follow.
      cancelAnimationFrame(frame);
      frame = 0;
      if (mode === "push") mode = "done";
      if (mode === "tour") mode = "ready";
    } else if (mode === "ready") {
      mode = "tour";
      clock = BEATS.ready;
    } else if (mode === "done") {
      mode = "tour";
      clock = AFTER_PUSH;
    }
    run();
  };
  const seen = new IntersectionObserver(
    (entries) => {
      visible = entries[entries.length - 1].isIntersecting;
      if (visible) run();
    },
    { rootMargin: "120px 0px" },
  );

  button.addEventListener("click", push);
  hit.addEventListener("click", push);
  still.addEventListener("change", onMotion);
  seen.observe(root);
  draw();

  return () => {
    cancelAnimationFrame(frame);
    seen.disconnect();
    button.removeEventListener("click", push);
    hit.removeEventListener("click", push);
    still.removeEventListener("change", onMotion);
    for (const [node, names] of original)
      for (const [name, value] of names) {
        if (value === null) node.removeAttribute(name);
        else node.setAttribute(name, value);
      }
  };
}
