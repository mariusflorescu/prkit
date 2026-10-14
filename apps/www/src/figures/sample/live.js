/**
 * Moves the sample figure: an idle tour from block to block, and the three buttons send the
 * carriage to a block. It writes attributes on the drawing's parts and never re-renders. It runs
 * only while the figure is on screen, and under reduced motion it skips the tour and snaps to each
 * new position. Missing parts leave it still; cleanup puts back every attribute it wrote.
 */
import { translateAlong } from "../kit/iso-kit.mjs";
import { P, needleAt } from "./geometry.mjs";
import { REACH, STOPS, blockUnder, heightUnder, tourAt, turnsAt } from "./model.mjs";

/** Seconds the carriage takes to close most of the gap to where it is sent. */
const FOLLOW = 0.28;
/** The plunger's spring, and how long the figure rests after a pick before touring again. */
const STIFF = 420;
const DRAG = 26;
const IDLE_MS = 3600;

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

export function mount(root) {
  const carriage = root.querySelector('[data-part="carriage"]');
  const plunger = root.querySelector('[data-part="plunger"]');
  const needle = root.querySelector('[data-part="needle"]');
  const buttons = [...root.querySelectorAll("button[data-block]")];
  if (!carriage || !plunger || !needle) return () => {};
  const still = matchMedia("(prefers-reduced-motion: reduce)");

  // What every written attribute was before mount, so cleanup can put it back.
  const original = new Map();
  const write = (node, name, value) => {
    const now = node.getAttribute(name);
    if (now === value) return;
    const seen = original.get(node) ?? new Map();
    if (!seen.has(name)) seen.set(name, now);
    original.set(node, seen);
    node.setAttribute(name, value);
  };

  let x = STOPS[0];
  let target = x;
  let tip = heightUnder(x);
  let rate = 0;
  let clock = 0;
  let last = 0;
  let frame = 0;
  let idle = 0;
  let visible = false;
  let touring = !still.matches;

  function draw() {
    write(carriage, "transform", translateAlong(P, [x, 0, 0]));
    write(plunger, "transform", translateAlong(P, [0, 0, tip]));
    write(needle, "d", needleAt(turnsAt(tip)));
    const under = blockUnder(x);
    buttons.forEach((button, index) => write(button, "aria-pressed", String(index === under)));
  }

  function tick(now) {
    const dt = last ? Math.min((now - last) / 1000, 1 / 30) : 1 / 60;
    last = now;
    if (touring) {
      clock += dt;
      target = tourAt(clock);
    }
    x += (target - x) * (1 - Math.exp(-dt / FOLLOW));
    if (Math.abs(target - x) < 0.01) x = target;
    const want = heightUnder(x);
    for (let step = 0; step < 4; step++) {
      rate += (((want - tip) * STIFF - rate * DRAG) * dt) / 4;
      tip += (rate * dt) / 4;
    }
    if (Math.abs(want - tip) < 0.005 && Math.abs(rate) < 0.005) {
      tip = want;
      rate = 0;
    }
    draw();
    const settled = !touring && x === target && rate === 0 && tip === want;
    frame = visible && !settled ? requestAnimationFrame(tick) : 0;
  }

  function run() {
    if (still.matches) {
      x = target;
      tip = heightUnder(x);
      rate = 0;
      draw();
      return;
    }
    if (!frame && visible) {
      last = 0;
      frame = requestAnimationFrame(tick);
    }
  }

  function steer(next) {
    touring = false;
    target = clamp(next, REACH[0], REACH[1]);
    clearTimeout(idle);
    idle = setTimeout(() => {
      touring = !still.matches;
      clock = 0;
      run();
    }, IDLE_MS);
    run();
  }

  const onClick = (event) => {
    const button =
      event.target instanceof Element ? event.target.closest("button[data-block]") : null;
    if (button) steer(STOPS[Number(button.dataset.block)]);
  };
  const onMotion = () => {
    touring = !still.matches;
    clock = 0;
    run();
  };
  const seen = new IntersectionObserver(
    (entries) => {
      visible = entries[entries.length - 1].isIntersecting;
      if (visible) run();
      else {
        cancelAnimationFrame(frame);
        frame = 0;
      }
    },
    { rootMargin: "120px 0px" },
  );

  root.addEventListener("click", onClick);
  still.addEventListener("change", onMotion);
  seen.observe(root);
  draw();

  return () => {
    cancelAnimationFrame(frame);
    clearTimeout(idle);
    seen.disconnect();
    root.removeEventListener("click", onClick);
    still.removeEventListener("change", onMotion);
    for (const [node, names] of original)
      for (const [name, value] of names) {
        if (value === null) node.removeAttribute(name);
        else node.setAttribute(name, value);
      }
  };
}
