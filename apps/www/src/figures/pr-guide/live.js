/**
 * Plays the hero: the agent reads the five files, writes the guide panel by panel, lands each chapter's anchors
 * while prkit ticks it off, then a new commit sends revision 1 back and revision 2 forms. Four buttons jump to a
 * step. It writes attributes on the drawing's parts and never re-renders; it runs only while
 * the figure is on screen, and under reduced motion it holds the still and snaps to each step without a frame.
 */
import { translateAlong } from "../kit/iso-kit.mjs";
import {
  BEATS,
  CHAPTERS,
  FILES,
  FORM,
  GLIDE,
  LAND,
  LOOP,
  MOMENTS,
  ORDER,
  PACE,
  STEP_BACK,
  STILL,
  READS,
  TICK,
  stateAt,
  timeOf,
} from "./model.mjs";
import { OLD, P, RISE } from "./view.mjs";

/** Seconds a jump to a step takes to close most of the gap to it. */
const FOLLOW = 0.24;
/** How long the figure rests at first (as the page's intro lands), and after a pick, before it tours again. */
const START_MS = 1100;
const IDLE_MS = 2000;

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const ease = (value) => value * value * (3 - 2 * value);
const lerp = (a, b, f) => a + (b - a) * f;
const mix = (a, b, f) => a.map((value, i) => lerp(value, b[i], f));
const fixed = (value) => (Math.round(value * 1000) / 1000).toString();
const opacity = (value) => (value >= 0.999 ? "1" : fixed(Math.max(0, value)));

/** The agent's stops, as the drawing measured them, or none if the drawing has no agent to move. */
function stopsOf(node) {
  try {
    const parsed = JSON.parse(node?.getAttribute("data-stops") ?? "");
    return parsed?.stops && parsed.foot ? parsed : null;
  } catch {
    return null;
  }
}

export function mount(root) {
  const svg = root.querySelector("svg");
  if (!svg) return () => {};
  const part = (name) => svg.querySelector(`[data-part="${name}"]`);
  const parts = (name) => [...svg.querySelectorAll(`[data-part="${name}"]`)];
  const buttons = [...root.querySelectorAll("button[data-moment]")];
  const row = buttons[0]?.parentElement;
  const still = matchMedia("(prefers-reduced-motion: reduce)");

  const agent = part("agent");
  const measured = stopsOf(agent);
  const shadow = part("agent-shadow");
  const beam = part("beam");
  const line = part("read-line");
  const files = FILES.map((_, index) => [part(`file-${index}-note`), part(`file-${index}-read`)]);
  const panels = [1, 2].map((r) =>
    ORDER.map((_, order) => {
      const node = part(`r${r}-${order}`);
      return { node, panel: node?.querySelector(".dg-panel") };
    }),
  );
  const anchors = CHAPTERS.map((chapter, c) =>
    chapter.files.map((_, link) => {
      const node = part(`anchor-${c}-${link}`);
      return { node, lines: [...(node?.querySelectorAll(".iso-line") ?? [])] };
    }),
  );
  const checks = CHAPTERS.map((_, c) => [part(`check-${c}-pass`), part(`check-${c}-pending`)]);
  const fresh = parts("graph-fresh");
  const oldTag = part("graph-ref-2");
  const oldTones = [...(oldTag?.querySelectorAll("[data-tone]") ?? [])];
  const newTag = part("graph-ref-3");

  let time = STILL;
  let target = STILL;
  let touring = false;
  let visible = false;
  let frame = 0;
  let last = 0;
  let idle = 0;

  // Every attribute is written through here, so the cleanup can put back what the drawing was built with.
  const written = new WeakMap();
  const touched = [];
  function write(node, name, value) {
    if (!node) return;
    let seen = written.get(node);
    if (!seen) {
      seen = new Map();
      written.set(node, seen);
    }
    if (!seen.has(name)) touched.push([node, name, node.getAttribute(name)]);
    if (seen.get(name) === value) return;
    seen.set(name, value);
    if (value === null) node.removeAttribute(name);
    else node.setAttribute(name, value);
  }

  /** How far along `name` is, eased, over `seconds`: 0 before it happens, 1 once it is done. */
  const along = (name, seconds) => ease(clamp((time - timeOf(name)) / seconds, 0, 1));

  /** Where the agent is and what its beam lights at `time`. */
  function agentAt() {
    const at = BEATS.findIndex((beat) => time < beat.at + beat.dur);
    const index = at < 0 ? BEATS.length - 1 : at;
    const beat = BEATS[index];
    const before = BEATS[(index + BEATS.length - 1) % BEATS.length];
    const f = ease(clamp((time - beat.at) / Math.min(GLIDE, beat.dur * 0.8), 0, 1));
    const stop = (b) => measured?.stops[b.stop];
    const from = stop(before);
    const to = stop(beat);
    if (!from || !to) return null;
    // The beam keeps the last line it lit while it fades, and lands straight on a new line as it comes on.
    let lit = index;
    for (let i = 0; i < BEATS.length && !BEATS[lit].beam; i++)
      lit = (lit + BEATS.length - 1) % BEATS.length;
    const shone = stop(BEATS[lit]);
    const sweep = beat.beam && before.beam && from.r && to.r;
    return {
      c: mix(from.c, to.c, f),
      s: mix(from.s, to.s, f),
      r: sweep ? mix(from.r, to.r, f) : (shone?.r ?? null),
      l: sweep ? mix(from.l, to.l, f) : (shone?.l ?? null),
      on: lerp(before.beam ? 1 : 0, beat.beam ? 1 : 0, f),
    };
  }

  function draw() {
    const state = stateAt(time);
    const commit = time >= timeOf("commit");
    const gone = 1 - along("end", 0.9 * PACE);
    const back = along("back", STEP_BACK);
    const reset = (seconds) => 1 - along("commit", seconds * PACE);

    FILES.forEach((_, index) => {
      // A file the new commit touched is read again for revision 2; the others keep what still holds.
      const again = READS[2].includes(index);
      const shown =
        Math.max(
          along(`read:1:${index}`, TICK) * (again ? reset(0.4) : 1),
          along(`read:2:${index}`, TICK),
        ) * gone;
      files[index].forEach((node) => write(node, "opacity", opacity(shown)));
    });

    ORDER.forEach((_, order) => {
      const first = panels[0][order];
      const formed = along(`panel:1:${order}`, FORM);
      const away = 1 - back;
      write(
        first.node,
        "transform",
        translateAlong(P, [-OLD.dx * away, -OLD.dy * away, -OLD.dz * away - RISE * (1 - formed)]),
      );
      write(first.node, "opacity", opacity(formed * (1 - 0.4 * back) * gone));
      write(first.panel, "class", back > 0.5 ? "dg-panel dg-glass" : "dg-panel");
      const second = panels[1][order];
      const forming = along(`panel:2:${order}`, FORM);
      write(second.node, "transform", translateAlong(P, [0, 0, -RISE * (1 - forming)]));
      write(second.node, "opacity", opacity(forming * gone));
    });

    CHAPTERS.forEach((chapter, c) => {
      const r = state.revision;
      const writing =
        time >= timeOf(`panel:${r}:${2 + c}`) && time < timeOf(`check:${r}:${c}`) && gone > 0;
      chapter.files.forEach((_, link) => {
        const { node, lines } = anchors[c][link];
        const landed = Math.max(
          along(`anchor:1:${c}:${link}`, LAND) * reset(0.5),
          along(`anchor:2:${c}:${link}`, LAND),
        );
        write(node, "opacity", opacity(landed * gone));
        lines.forEach((path) => write(path, "data-tone", writing ? "lit" : "mid"));
      });
      const passed =
        Math.max(along(`check:1:${c}`, TICK) * reset(0.4), along(`check:2:${c}`, TICK)) * gone;
      write(checks[c][0], "opacity", opacity(passed));
      write(checks[c][1], "opacity", opacity(1 - passed));
    });

    fresh.forEach((node) => write(node, "opacity", opacity(along("commit", 0.6 * PACE) * gone)));
    // Each revision's ref is tagged once its last chapter checks, as prkit keeps refs only for accepted revisions.
    const last = CHAPTERS.length - 1;
    write(oldTag, "opacity", opacity(along(`check:1:${last}`, TICK) * gone));
    oldTones.forEach((node) => write(node, "data-tone", commit && gone > 0.5 ? "lo" : "hi"));
    write(newTag, "opacity", opacity(along(`check:2:${last}`, TICK) * gone));

    const pose = agentAt();
    if (pose && measured) {
      write(agent, "transform", `translate(${fixed(pose.c[0])} ${fixed(pose.c[1])})`);
      write(shadow, "transform", `translate(${fixed(pose.s[0])} ${fixed(pose.s[1])})`);
      const lit = opacity(pose.on);
      for (const node of [beam, line, shadow]) write(node, "opacity", lit);
      if (pose.r) {
        const [fx, fy] = [measured.foot[0] + pose.c[0], measured.foot[1] + pose.c[1]];
        const [ax, ay, bx, by] = pose.r.map(fixed);
        write(beam, "d", `M${fixed(fx)} ${fixed(fy)}L${ax} ${ay}L${bx} ${by}Z`);
      }
      if (pose.l) {
        const [ax, ay, bx, by] = pose.l.map(fixed);
        write(line, "d", `M${ax} ${ay}L${bx} ${by}`);
      }
    }

    buttons.forEach((button, index) => {
      const moment = MOMENTS[index];
      if (moment) write(button, "aria-pressed", String(time >= moment.from && time < moment.to));
    });
  }

  function tick(now) {
    const dt = last ? Math.min((now - last) / 1000, 1 / 30) : 1 / 60;
    last = now;
    if (touring) {
      target = (target + dt) % LOOP;
      time = target;
    } else {
      time += (target - time) * (1 - Math.exp(-dt / FOLLOW));
      if (Math.abs(target - time) < 0.002) time = target;
    }
    draw();
    frame = visible && (touring || time !== target) ? requestAnimationFrame(tick) : 0;
  }

  function run() {
    if (still.matches) {
      touring = false;
      time = target;
      draw();
      return;
    }
    if (!frame && visible) {
      last = 0;
      frame = requestAnimationFrame(tick);
    }
  }

  function rest(ms) {
    clearTimeout(idle);
    idle = setTimeout(() => {
      if (still.matches) return;
      touring = true;
      target = time;
      run();
    }, ms);
  }

  function steer(next) {
    touring = false;
    target = next;
    // Under reduced motion there is no tour to go back to, so a step stays until the next one.
    if (!still.matches) rest(IDLE_MS);
    run();
  }

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

  // The buttons are one stop for Tab, and the arrow keys move along them, picking as they go, so a screen reader
  // announces each step on the button itself.
  const rove = (to) =>
    buttons.forEach((button) => write(button, "tabindex", button === to ? "0" : "-1"));
  const pick = (button) => {
    const moment = MOMENTS[Number(button.dataset.moment)];
    if (!moment) return;
    rove(button);
    steer(moment.at);
  };
  const onClick = (event) => pick(event.currentTarget);
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
    }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    buttons[next].focus();
    pick(buttons[next]);
  };
  const onMotion = () => {
    if (still.matches) {
      // Snap to the still rather than freeze mid-tour.
      cancelAnimationFrame(frame);
      frame = 0;
      clearTimeout(idle);
      touring = false;
      target = STILL;
    } else rest(START_MS);
    run();
  };

  rove(buttons.find((button) => button.getAttribute("aria-pressed") === "true") ?? buttons[0]);
  buttons.forEach((button) => button.addEventListener("click", onClick));
  row?.addEventListener("keydown", onKey);
  still.addEventListener("change", onMotion);
  seen.observe(root);
  draw();
  if (!still.matches) rest(START_MS);

  return () => {
    cancelAnimationFrame(frame);
    clearTimeout(idle);
    seen.disconnect();
    buttons.forEach((button) => button.removeEventListener("click", onClick));
    row?.removeEventListener("keydown", onKey);
    still.removeEventListener("change", onMotion);
    for (const [node, name, value] of touched.toReversed()) {
      if (value === null) node.removeAttribute(name);
      else node.setAttribute(name, value);
    }
  };
}
