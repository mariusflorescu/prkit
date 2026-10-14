/**
 * Runs the local-first figure. While it is on screen it plays the tour from model.mjs: a request carries one
 * account's GitHub token out to GitHub and an answer comes back into the inbox; a job goes to your agent, which works on
 * its own copy and replies; a search of prkit's data folder for a GitHub token finds nothing. The reader follows one of
 * them with its button or the arrow keys. It writes attributes on the drawing's parts and never
 * re-renders. Under reduced motion it holds the rest frame and snaps to each choice without asking for a frame.
 * Missing parts leave it still.
 */
import { translateAlong } from "../kit/iso-kit.mjs";
import { P, SCAN, TREE_ROWS, pulseShift } from "./geometry.mjs";
import { ACCOUNTS, HOLD, LOOP, STEPS, tourAt, tripOf } from "./model.mjs";

/** How long the tour waits after the reader's last choice before it carries on. */
const QUIET = 2400;
/** The rows the agent types while it works. */
const TYPED = 3;

export function mount(root) {
  const svg = root.querySelector("svg");
  const buttons = [...root.querySelectorAll("button[data-step]")];
  if (!svg || buttons.length !== STEPS.length) return () => {};
  const row = buttons[0].parentElement;
  const still = matchMedia("(prefers-reduced-motion: reduce)");
  const part = (name) => svg.querySelector(`[data-part="${name}"]`);
  const pulse = (name) => svg.querySelector(`[data-pulse="${name}"]`);
  const line = (name) => svg.querySelector(`[data-line="${name}"]`);

  const refs = {
    request: pulse("github-out"),
    answer: pulse("github-back"),
    job: pulse("agent-out"),
    reply: pulse("agent-back"),
    tokens: ACCOUNTS.map((_, i) => part(`token-${i}`)),
    api: ACCOUNTS.map((_, i) => part(`api-${i}`)),
    fresh: part("fresh"),
    agentLine: line("agent"),
    copyLine: line("copy"),
    copyLit: part("copy-lit"),
    typed: Array.from({ length: TYPED }, (_, i) => svg.querySelector(`[data-type="${i}"]`)),
    scan: part("scan"),
    empty: part("empty"),
  };

  let clock = 0;
  let touring = !still.matches;
  /** The step the reader picked, or null. */
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
  const ride = (node, name, trip) => {
    show(node, trip !== null);
    if (trip) write(node, "transform", translateAlong(P, pulseShift(name, trip.along)));
  };

  function draw() {
    const tour = tourAt(clock);
    const trip = tour.step ? tripOf(tour.at) : null;
    const on = (name) => tour.step === name;
    const working = trip?.there === true;

    // GitHub: the request carries the account's token out; the answer comes back into the inbox.
    ride(refs.request, "github", on("github") && trip?.out && !working ? trip : null);
    ride(refs.answer, "github", on("github") && trip && !trip.out ? trip : null);
    refs.tokens.forEach((node, i) => show(node, on("github") && i === tour.account));
    refs.api.forEach((node, i) =>
      show(node, on("github") && tour.at >= 0.38 && i === tour.account),
    );
    show(refs.fresh, on("github") && tour.at >= 0.9);

    // Your agent: the job goes over, the agent types on its own copy, the reply comes back.
    ride(refs.job, "agent", on("agent") && trip?.out && !working ? trip : null);
    ride(refs.reply, "agent", on("agent") && trip && !trip.out ? trip : null);
    write(refs.agentLine, "data-tone", on("agent") ? "hi" : "mid");
    write(refs.copyLine, "data-tone", on("agent") && working ? "lit" : "mid");
    show(refs.copyLit, on("agent") && working);
    const typed = on("agent") ? Math.ceil(((tour.at - 0.4) / 0.2) * TYPED) : 0;
    refs.typed.forEach((node, i) => show(node, i < typed));

    // Disk: the search's band runs down the folder, then it answers with no results.
    const scanning = on("disk") && tour.at < 0.6;
    show(refs.scan, scanning);
    if (scanning)
      write(
        refs.scan,
        "transform",
        `translate(0 ${((tour.at / 0.6) * (TREE_ROWS - 1) * SCAN).toFixed(2)})`,
      );
    show(refs.empty, on("disk") && tour.at >= 0.6);

    buttons.forEach((button) =>
      write(button, "aria-pressed", String(button.dataset.step === picked)),
    );
  }

  function tick(now) {
    const dt = last ? Math.min((now - last) / 1000, 1 / 30) : 1 / 60;
    last = now;
    clock += dt;
    // Keep the clock small, but on a whole number of loops so the account each pass uses still turns.
    if (clock > LOOP * ACCOUNTS.length * 100) clock -= LOOP * ACCOUNTS.length * 100;
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

  /** The reader follows one connection, or none with null. The tour carries on after a quiet spell. */
  const choose = (name) => {
    clearTimeout(idle);
    picked = name;
    touring = false;
    clock = name ? HOLD[name] : 0;
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

  // The buttons are one stop for Tab, and the arrow keys move along them, picking as they go.
  const rove = (to) =>
    buttons.forEach((button) => write(button, "tabindex", button === to ? "0" : "-1"));
  rove(buttons[0]);
  const onClick = (event) => {
    const button = event.currentTarget;
    rove(button);
    choose(button.getAttribute("aria-pressed") === "true" ? null : button.dataset.step);
  };
  buttons.forEach((button) => button.addEventListener("click", onClick));
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
    choose(button.dataset.step);
  };
  row?.addEventListener("keydown", onKey);
  const onMotion = () => {
    clearTimeout(idle);
    picked = null;
    touring = !still.matches;
    clock = 0;
    run();
  };
  still.addEventListener("change", onMotion);
  draw();

  return () => {
    cancelAnimationFrame(frame);
    clearTimeout(idle);
    seen.disconnect();
    buttons.forEach((button) => button.removeEventListener("click", onClick));
    row?.removeEventListener("keydown", onKey);
    still.removeEventListener("change", onMotion);
    before.forEach((names, node) =>
      names.forEach((value, name) =>
        value === null ? node.removeAttribute(name) : node.setAttribute(name, value),
      ),
    );
  };
}
