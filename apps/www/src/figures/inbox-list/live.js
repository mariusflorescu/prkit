// The inbox list, live: plays the tour from model.mjs and answers to an account pick from the buttons. It writes
// attributes on the drawing's parts (and rewrites the group cards' outlines as they shrink) and never re-renders.
// It runs only while the figure is on screen. Under reduced motion it holds All accounts and snaps to each pick
// without asking for a frame. Missing parts leave it still; cleanup puts back every attribute it wrote.
import { translateAlong } from "../kit/iso-kit.mjs";
import {
  ACCOUNTS,
  LEAD,
  LOOP,
  MEMBERS,
  PICK_LENGTH,
  PULLS,
  TOUR,
  HOLD,
  itemOf,
  pickAt,
  restOf,
  tourAt,
} from "./model.mjs";
import { P, POPUP_ROW, cardPaths, layoutOf } from "./view.mjs";

/** After a pick, the tour comes back once the reader has left it alone this long, in ms. */
const QUIET = 2800;
const LIFT = 2.4;
const STILL = restOf(null);
const REST = layoutOf(STILL.rows, STILL.groups);
const clamp01 = (value) => Math.min(1, Math.max(0, value));
const fine = (value) => (Math.abs(value - 1) < 0.002 ? "1" : clamp01(value).toFixed(3));

export function mount(root) {
  const svg = root.querySelector("svg");
  const buttons = [...root.querySelectorAll("button[data-pick]")];
  if (!svg || buttons.length !== ACCOUNTS.length + 1) return () => {};
  const row = buttons[0].parentElement;
  const part = (name) => svg.querySelector(`[data-part="${name}"]`);
  const cards = MEMBERS.map((_, group) => part(`card-${group}`));
  const heads = MEMBERS.map((_, group) => part(`head-${group}`));
  const pips = MEMBERS.map((members, group) => members.map((_, i) => part(`pip-${group}-${i}`)));
  const rows = PULLS.map((_, index) => svg.querySelector(`[data-row="${index}"]`));
  const popup = part("popup");
  const shadow = part("popup-shadow");
  const hover = part("popup-hover");
  const checks = [0, 1, 2, 3].map((i) => part(`popup-check-${i}`));
  const triggers = [0, 1, 2, 3].map((i) => part(`trigger-${i}`));
  const refs = [
    ...cards,
    ...heads,
    ...pips.flat(),
    ...rows,
    popup,
    shadow,
    hover,
    ...checks,
    ...triggers,
  ];
  if (refs.some((ref) => !ref)) return () => {};
  const cardPathsOf = cards.map((card) => ({
    fill: [...card.querySelectorAll(".iso-halo, .iso-fill")],
    shades: [0, 1, 2, 3].map((shade) => card.querySelector(`.iso-shade[data-shade="${shade}"]`)),
    top: card.querySelector(".iso-top"),
    crease: card.querySelector(".iso-crease"),
    bevel: card.querySelector(".iso-bevel"),
    outline: card.querySelector(".iso-edge"),
  }));

  const still = matchMedia("(prefers-reduced-motion: reduce)");
  // What every written attribute was before mount, so cleanup can put it back.
  const original = new Map();
  const write = (node, name, value) => {
    if (!node) return;
    const now = node.getAttribute(name);
    if (now === value) return;
    const seen = original.get(node) ?? new Map();
    if (!seen.has(name)) seen.set(name, now);
    original.set(node, seen);
    if (value === null) node.removeAttribute(name);
    else node.setAttribute(name, value);
  };

  let mode = "tour";
  let clock = 0;
  let pick = { u: 0, from: STILL, to: null };
  let shown = STILL;
  let visible = false;
  let frame = 0;
  let last = 0;
  let idle = 0;

  function apply(state) {
    shown = state;
    const layout = layoutOf(state.rows, state.groups);
    layout.cards.forEach((card, group) => {
      const paths = cardPaths(card);
      const slots = cardPathsOf[group];
      slots.fill.forEach((node) => write(node, "d", paths.fill));
      slots.shades.forEach((node, shade) => write(node, "d", paths.shades[shade]));
      write(slots.top, "d", paths.top);
      write(slots.crease, "d", paths.crease);
      write(slots.bevel, "d", paths.bevel ?? "");
      write(slots.outline, "d", paths.outline);
      const presence = fine(state.groups[group]);
      write(cards[group], "opacity", presence === "1" ? null : presence);
      const dy = card.y - REST.cards[group].y;
      write(heads[group], "transform", dy ? translateAlong(P, [0, dy, 0]) : null);
      // The header goes before its card does, so nothing hangs over the card's shrinking edge.
      const head = fine((state.groups[group] - 0.4) / 0.6);
      write(heads[group], "opacity", head === "1" ? null : head);
      const count = MEMBERS[group].reduce((sum, index) => sum + state.rows[index], 0);
      pips[group].forEach((pip, i) => {
        const on = fine(count - i);
        write(pip, "opacity", on === "1" ? null : on);
      });
    });
    rows.forEach((node, index) => {
      const dy = layout.rows[index] - REST.rows[index];
      write(node, "transform", Math.abs(dy) > 0.001 ? translateAlong(P, [0, dy, 0]) : null);
      // A row leaving fades out in the first half of its collapse, so it never shows past its card.
      const on = fine((state.rows[index] - 0.5) * 2);
      write(node, "opacity", on === "1" ? null : on);
    });
    const open = clamp01(state.popup);
    write(popup, "opacity", fine(open));
    write(popup, "transform", open < 1 ? translateAlong(P, [0, 0, -(1 - open) * LIFT]) : null);
    write(shadow, "opacity", fine(open * 0.85));
    write(
      hover,
      "transform",
      state.hover ? `translate(0 ${(state.hover * POPUP_ROW).toFixed(2)})` : null,
    );
    const item = itemOf(state.choice);
    checks.forEach((node, i) => write(node, "opacity", i === item ? null : "0"));
    triggers.forEach((node, i) => write(node, "opacity", i === item ? null : "0"));
    buttons.forEach((button) =>
      write(button, "aria-pressed", String(pickOf(button) === state.choice)),
    );
  }

  const pickOf = (button) => (button.dataset.pick === "all" ? null : Number(button.dataset.pick));
  /** The tour time that rests on a choice, so the tour picks up where the reader left it. */
  const clockOf = (choice) => {
    const step = TOUR.indexOf(choice);
    return choice === null ? 0 : LEAD + step * (PICK_LENGTH + HOLD) + PICK_LENGTH;
  };

  const stateNow = () => (mode === "tour" ? tourAt(clock) : pickAt(pick.u, pick.from, pick.to));
  const settled = () => mode === "pick" && pick.u >= PICK_LENGTH;

  function tick(now) {
    const dt = last ? Math.min((now - last) / 1000, 1 / 30) : 1 / 60;
    last = now;
    if (mode === "tour") clock = (clock + dt) % LOOP;
    else pick.u = Math.min(PICK_LENGTH, pick.u + dt);
    apply(stateNow());
    frame = visible && !settled() ? requestAnimationFrame(tick) : 0;
    if (!frame) last = 0;
  }
  function run() {
    if (still.matches) {
      apply(stateNow());
      return;
    }
    if (!frame && visible && !settled()) frame = requestAnimationFrame(tick);
  }

  function choose(next) {
    clearTimeout(idle);
    if (still.matches) {
      // No tour to go back to: the pick snaps there and stays until the next one.
      mode = "pick";
      pick = { u: PICK_LENGTH, from: restOf(next), to: next };
      apply(restOf(next));
      return;
    }
    mode = "pick";
    pick = { u: 0, from: shown, to: next };
    idle = setTimeout(
      () => {
        mode = "tour";
        clock = clockOf(pick.to);
        run();
      },
      QUIET + PICK_LENGTH * 1000,
    );
    run();
  }

  const observer = new IntersectionObserver(
    (entries) => {
      visible = entries[entries.length - 1].isIntersecting;
      if (visible) run();
    },
    { rootMargin: "120px 0px" },
  );
  observer.observe(root);

  // The buttons are one stop for Tab, and the arrow keys move along them, picking as they go.
  const rove = (to) =>
    buttons.forEach((button) => write(button, "tabindex", button === to ? "0" : "-1"));
  rove(buttons[0]);
  const onClick = (event) => {
    rove(event.currentTarget);
    choose(pickOf(event.currentTarget));
  };
  buttons.forEach((button) => button.addEventListener("click", onClick));
  const onKey = (event) => {
    const at = buttons.findIndex((button) => button === event.target);
    if (at < 0) return;
    const count = buttons.length;
    const next = {
      ArrowRight: (at + 1) % count,
      ArrowDown: (at + 1) % count,
      ArrowLeft: (at + count - 1) % count,
      ArrowUp: (at + count - 1) % count,
      Home: 0,
      End: count - 1,
      Escape: 0,
    }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    buttons[next].focus();
    rove(buttons[next]);
    choose(pickOf(buttons[next]));
  };
  row?.addEventListener("keydown", onKey);

  const onMotion = () => {
    cancelAnimationFrame(frame);
    frame = 0;
    last = 0;
    clearTimeout(idle);
    // Snap to rest rather than freeze half way through a pick.
    mode = "tour";
    clock = 0;
    run();
  };
  still.addEventListener("change", onMotion);
  apply(still.matches ? STILL : stateNow());

  return () => {
    cancelAnimationFrame(frame);
    clearTimeout(idle);
    observer.disconnect();
    buttons.forEach((button) => button.removeEventListener("click", onClick));
    row?.removeEventListener("keydown", onKey);
    still.removeEventListener("change", onMotion);
    for (const [node, names] of original)
      for (const [name, value] of names) {
        if (value === null) node.removeAttribute(name);
        else node.setAttribute(name, value);
      }
  };
}
