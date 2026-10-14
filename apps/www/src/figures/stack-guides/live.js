/**
 * Runs the stack figure. While it is on screen it plays the tour from model.mjs: Whole stack starts a guide for
 * each layer, bottom to top, two at a time; the agent's cursor types each one row by row; then each layer is shown
 * in turn. The reader picks a layer with its button or the arrow keys, and Whole stack plays the batch again on a
 * fresh stack. It writes attributes on the drawing's parts and never re-renders. Under reduced motion it holds the
 * rest frame and snaps to each choice without asking for a frame. Missing parts leave it still.
 */
import { translateAlong } from "../kit/iso-kit.mjs";
import { P, cursorShift, typingOf } from "./geometry.mjs";
import { BATCH_START, HOME, LAYERS, LOOP, T_STILL, T_WRITTEN, stateAt } from "./model.mjs";

/** How long the tour waits after the reader's last choice before it carries on. */
const QUIET = 2400;
/** How faint the other layers go while one is picked. */
const BACK = 0.38;

export function mount(root) {
  const svg = root.querySelector("svg");
  const buttons = [...root.querySelectorAll("button[data-layer-button], button[data-whole]")];
  if (!svg || buttons.length !== LAYERS.length + 1) return () => {};
  const layerButtons = buttons.slice(0, LAYERS.length);
  const whole = buttons[LAYERS.length];
  const row = whole.parentElement;
  const still = matchMedia("(prefers-reduced-motion: reduce)");
  const part = (name) => svg.querySelector(`[data-part="${name}"]`);

  const layers = LAYERS.map((_, layer) => {
    const guide = part(`guide-${layer}`);
    const link = part(`link-${layer}`);
    return {
      lifts: [...svg.querySelectorAll(`[data-lift="${layer}"]`)],
      ghost: part(`ghost-${layer}`),
      queued: part(`queued-${layer}`),
      guide,
      cursor: part(`cursor-${layer}`),
      link,
      line: link?.querySelector(".sg-link") ?? null,
      range: part(`range-${layer}`),
      // Each row's words, with where each starts along the row.
      rows: [...(guide?.querySelectorAll("[data-row]") ?? [])].map((node) =>
        [...node.querySelectorAll("[data-rest], [data-ref]")].map((mark) => ({
          node: mark,
          x: Number(mark.getAttribute("x") ?? mark.dataset.ref ?? 0),
          rest: mark.dataset.rest,
        })),
      ),
      strip: ["writing", "ready"].map((state) => ({
        state,
        nodes: [...svg.querySelectorAll(`[data-strip="${layer}"][data-state="${state}"]`)],
      })),
    };
  });

  let clock = T_STILL;
  let touring = !still.matches;
  /** The layer the reader picked, or null for the whole stack. */
  let picked = null;
  let visible = false;
  let frame = 0;
  let last = 0;
  let idle = 0;

  // Every attribute this writes, with the value it had before, so cleanup can put each one back.
  const before = new Map();
  const write = (node, name, value) => {
    if (!node) return;
    const now = node.getAttribute(name);
    if (now === value) return;
    const seen = before.get(node) ?? new Map();
    if (!seen.has(name)) seen.set(name, now);
    before.set(node, seen);
    if (value === null) node.removeAttribute(name);
    else node.setAttribute(name, value);
  };
  const show = (node, on) => write(node, "visibility", on ? null : "hidden");

  function draw() {
    const pose = stateAt(clock);
    const chosen = touring ? (pose.picked ? pose.on : null) : picked;
    layers.forEach((layer, index) => {
      const { state, written, shown } = pose.guides[index];
      const drawn = state === "writing" || state === "ready";
      const writing = state === "writing";
      show(layer.ghost, !drawn);
      show(layer.queued, state === "queued");
      show(layer.guide, drawn);
      show(layer.link, drawn);
      const fade = shown < 0.999 ? `opacity:${shown.toFixed(3)}` : null;
      write(layer.guide, "style", fade);
      write(layer.link, "style", fade);
      write(layer.line, "data-tone", writing ? "lit" : "mid");
      write(layer.range, "data-tone", writing ? "lit" : "hi");
      const typing = typingOf(index, written);
      layer.rows.forEach((marks, at) =>
        marks.forEach((mark) => {
          show(
            mark.node,
            typing.at < 0 || at < typing.at || (at === typing.at && mark.x < typing.u),
          );
          if (mark.rest) write(mark.node, "data-tone", at === typing.at ? "lit" : mark.rest);
        }),
      );
      show(layer.cursor, writing);
      if (writing)
        write(
          layer.cursor,
          "transform",
          translateAlong(P, cursorShift(index, typing.at, typing.u)),
        );
      // The strip shows a queued guide as being written, as the app shows a preparing review.
      const look = state === "queued" ? "writing" : state;
      layer.strip.forEach(({ state: icon, nodes }) =>
        nodes.forEach((node) => show(node, icon === look)),
      );
      const faint = chosen !== null && chosen !== index;
      layer.lifts.forEach((node) => write(node, "style", faint ? `opacity:${BACK}` : null));
    });
    layerButtons.forEach((button, index) =>
      write(button, "aria-pressed", String(chosen === index)),
    );
  }

  function tick(now) {
    const dt = last ? Math.min((now - last) / 1000, 1 / 30) : 1 / 60;
    last = now;
    clock = (clock + dt) % LOOP;
    draw();
    frame = visible && touring ? requestAnimationFrame(tick) : 0;
    if (!frame) last = 0;
  }
  const run = () => {
    if (still.matches || !touring) {
      cancelAnimationFrame(frame);
      frame = 0;
      last = 0;
      draw();
      return;
    }
    if (!frame && visible) frame = requestAnimationFrame(tick);
  };

  /** The reader picks a layer, or the whole stack with null. The tour carries on after a quiet spell. */
  const choose = (layer) => {
    touring = false;
    picked = layer;
    clearTimeout(idle);
    // Under reduced motion there is no tour to go back to, so a choice stays until the next one.
    if (!still.matches)
      idle = setTimeout(() => {
        picked = null;
        touring = true;
        run();
      }, QUIET);
    run();
  };

  const seen = new IntersectionObserver(
    (entries) => {
      visible = entries[entries.length - 1].isIntersecting;
      if (visible) run();
      else {
        cancelAnimationFrame(frame);
        frame = 0;
        last = 0;
      }
    },
    { rootMargin: "120px 0px" },
  );
  seen.observe(root);

  // The buttons are one stop for Tab, and the arrow keys move along them. Moving onto a layer picks it, so a
  // screen reader announces it on the button; Whole stack waits for Enter or Space.
  const rove = (to) =>
    buttons.forEach((button) => write(button, "tabindex", button === to ? "0" : "-1"));
  rove(layerButtons[HOME]);
  const onLayer = (event) => {
    const button = event.currentTarget;
    rove(button);
    const layer = Number(button.dataset.layerButton);
    choose(button.getAttribute("aria-pressed") === "true" ? null : layer);
  };
  layerButtons.forEach((button) => button.addEventListener("click", onLayer));
  // Whole stack only starts layers without a guide, so it starts from a fresh stack, none of whose layers has one
  // yet, and writes them bottom to top, two at a time.
  const onWhole = () => {
    rove(whole);
    clearTimeout(idle);
    picked = null;
    if (still.matches) {
      touring = false;
      clock = T_WRITTEN;
    } else {
      touring = true;
      clock = BATCH_START;
    }
    run();
  };
  whole.addEventListener("click", onWhole);
  const onKey = (event) => {
    const at = buttons.findIndex((button) => button === event.target);
    if (at < 0) return;
    if (event.key === "Escape") {
      event.preventDefault();
      choose(null);
      return;
    }
    const count = buttons.length;
    const next = {
      ArrowRight: (at + 1) % count,
      ArrowDown: (at + 1) % count,
      ArrowLeft: (at + count - 1) % count,
      ArrowUp: (at + count - 1) % count,
      Home: 0,
      End: count - 1,
    }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    const button = buttons[next];
    button.focus();
    rove(button);
    if (next < LAYERS.length) choose(next);
  };
  row?.addEventListener("keydown", onKey);
  const onMotion = () => {
    clearTimeout(idle);
    picked = null;
    touring = !still.matches;
    if (still.matches) clock = T_STILL;
    run();
  };
  still.addEventListener("change", onMotion);
  draw();

  return () => {
    cancelAnimationFrame(frame);
    clearTimeout(idle);
    seen.disconnect();
    layerButtons.forEach((button) => button.removeEventListener("click", onLayer));
    whole.removeEventListener("click", onWhole);
    row?.removeEventListener("keydown", onKey);
    still.removeEventListener("change", onMotion);
    before.forEach((names, node) =>
      names.forEach((value, name) =>
        value === null ? node.removeAttribute(name) : node.setAttribute(name, value),
      ),
    );
  };
}
