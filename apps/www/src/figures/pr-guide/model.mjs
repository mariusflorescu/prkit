// The truth behind the hero: a pull request read by your own agent and explained as a guide.
//
// The pull request is the one in the site's own screenshots (apps/www/src/assets/shots/progress-*.webp and
// guide-*.webp): five changed files, +58 -9, and a guide of three chapters, two core and then tests. A guide is an
// overview, a before/after flow, then chapters, core first, and prkit checks that every chapter points at real lines
// of the diff before it is shown (docs/internals/architecture.md). A new head starts revision 2 while revision 1
// stays readable.
//
// The tour below is the truth the page plays: every count it shows comes from the same events the drawing shows.

/** The changed files in diff order. `hunks` are [deleted, added] runs, summing to the file's real counts. */
export const FILES = [
  {
    path: "src/server.js",
    additions: 13,
    deletions: 2,
    hunks: [
      [1, 5],
      [1, 8],
    ],
  },
  { path: "src/shorten.js", additions: 9, deletions: 4, hunks: [[4, 9]] },
  {
    path: "src/store.js",
    additions: 11,
    deletions: 3,
    hunks: [
      [2, 4],
      [1, 7],
    ],
  },
  { path: "src/validate.js", additions: 14, deletions: 0, hunks: [[0, 14]] },
  { path: "test/validate.test.js", additions: 11, deletions: 0, hunks: [[0, 11]] },
];

/** The guide's chapters, core change first. Every file sits in exactly one chapter, which prkit checks. */
export const CHAPTERS = [
  { title: "Only http and https links can be shortened", kind: "core", files: [3, 1] },
  { title: "Every redirect counts a click and stats reads it back", kind: "core", files: [0, 2] },
  { title: "Tests cover accept and reject for validateUrl", kind: "tests", files: [4] },
];

/**
 * A file's rows as the sheet draws them: per hunk a header, one line of context, the removed lines, the added
 * lines, one line of context. Returns the kinds and each hunk's [first, last] row.
 */
export function rowsOf(file) {
  const kinds = [];
  const hunks = [];
  for (const [deleted, added] of file.hunks) {
    const first = kinds.length;
    kinds.push("hunk", "ctx");
    for (let i = 0; i < deleted; i++) kinds.push("del");
    for (let i = 0; i < added; i++) kinds.push("add");
    kinds.push("ctx");
    hunks.push([first, kinds.length - 1]);
  }
  return { kinds, hunks };
}

/** The guide panels in the order the agent writes them: overview, flow, then the chapters, core first. */
export const ORDER = [
  { kind: "overview" },
  { kind: "flow" },
  ...CHAPTERS.map((_, chapter) => ({ kind: "chapter", chapter })),
];
/** The rows of a file the agent's beam rests on as it reads: the first, middle and last changed line. */
export function readRowsOf(file) {
  const { kinds } = rowsOf(file);
  const changed = kinds.flatMap((kind, row) => (kind === "add" || kind === "del" ? [row] : []));
  return [changed[0], changed[Math.floor(changed.length / 2)], changed[changed.length - 1]];
}
/** The row an anchor lands on: the middle changed line of the file's first hunk. */
export function anchorRowOf(file) {
  const { kinds, hunks } = rowsOf(file);
  const [first, last] = hunks[0];
  const changed = [];
  for (let row = first; row <= last; row++)
    if (kinds[row] === "add" || kinds[row] === "del") changed.push(row);
  return changed[Math.floor(changed.length / 2)];
}

/**
 * The files each revision reads. The first reads the whole diff; the new commit touches only the test file, and an
 * update reads what changed since revision 1 alongside the previous guide, keeping what still holds.
 */
export const TOUCHED = [4];
export const READS = { 1: FILES.map((_, index) => index), 2: TOUCHED };

/**
 * The pace of the agent's writing and checking: its panel, anchor and check beats and the animations inside them,
 * scaled together so the still the drawing is made in stays the same picture.
 */
export const PACE = 0.39;
/** Reading keeps more of its first pace, so the beam's hops from line to line glide calmly. */
const READ_PACE = 0.75;
/** How long the agent takes to glide to its next stop: never under 0.3 s, so nothing jerks. */
export const GLIDE = 0.45 * READ_PACE;

/** How long a guide panel takes to form, an anchor to land, a check to tick, a file's tick to show. */
export const FORM = 0.7 * PACE;
export const LAND = 0.45 * PACE;
export const TICK = 0.35 * PACE;
export const STEP_BACK = 1.3 * PACE;

/**
 * The tour as beats: where the agent is (`stop`, named in the drawing) and whether its beam is on, from `at` for
 * `dur` seconds. `events` holds when each thing happened, by name: `read:<r>:<file>`, `panel:<r>:<order>`,
 * `anchor:<r>:<chapter>:<link>`, `check:<r>:<chapter>`, `commit`, `back`, `end`.
 */
function tour() {
  const beats = [];
  const events = new Map();
  let at = 0;
  const beat = (stop, beam, dur) => {
    beats.push({ stop, beam, at, dur });
    at += dur;
  };
  const revision = (r) => {
    const step = (seconds) => seconds * PACE;
    READS[r].forEach((index) => {
      const file = FILES[index];
      readRowsOf(file).forEach((_, row) => beat(`read-${index}-${row}`, true, 0.55 * READ_PACE));
      events.set(`read:${r}:${index}`, at - 0.1 * PACE);
    });
    ORDER.forEach((panel, order) => {
      events.set(`panel:${r}:${order}`, at + 0.3 * PACE);
      beat(`panel-${order}`, false, step(panel.kind === "chapter" ? 1.0 : 1.1));
      if (panel.kind !== "chapter") return;
      CHAPTERS[panel.chapter].files.forEach((_, link) => {
        events.set(`anchor:${r}:${panel.chapter}:${link}`, at + 0.4 * PACE);
        beat(`anchor-${panel.chapter}-${link}`, true, step(1.0));
      });
      // prkit checks the chapter once its last anchor has landed.
      events.set(`check:${r}:${panel.chapter}`, at + 0.35 * PACE);
      beat(`anchor-${panel.chapter}-${CHAPTERS[panel.chapter].files.length - 1}`, true, 0.7 * PACE);
    });
  };
  // The holds between the acts are short, so the whole story fits in about twenty seconds.
  revision(1);
  beat(beats[beats.length - 1].stop, false, 0.6);
  // A new commit lands on the head: revision 1 steps back and the agent reads what it changed for revision 2.
  events.set("commit", at);
  events.set("back", at + 0.3);
  beat("panel-4", false, 1.0);
  revision(2);
  beat(beats[beats.length - 1].stop, false, 1.0);
  events.set("end", at);
  beat(beats[0].stop, false, 0.45);
  return { beats, events, loop: at };
}
const TOUR = tour();
export const BEATS = TOUR.beats;
export const LOOP = TOUR.loop;
/** When `name` happened, or never. */
export const timeOf = (name) => TOUR.events.get(name) ?? Number.POSITIVE_INFINITY;

/** The counts true at `t`: the revision being written, the files read for it, the chapters prkit has checked. */
export function stateAt(t) {
  const revision = t >= timeOf("commit") ? 2 : 1;
  const happened = (name) => timeOf(name) <= t;
  const read = READS[revision].filter((index) => happened(`read:${revision}:${index}`)).length;
  const settled = CHAPTERS.filter((_, chapter) => happened(`check:${revision}:${chapter}`)).length;
  return { t, revision, read, files: READS[revision].length, settled };
}

/**
 * The still the drawing is made in and rests on: revision 2, every file read, two chapters checked, and the agent
 * landing the last chapter's anchor on the test file.
 */
export const STILL = timeOf(`anchor:2:${CHAPTERS.length - 1}:0`) + LAND + 0.05 * PACE;

/**
 * The steps a reader can jump to, each shown at a moment that says it, and pressed for its whole span. A button's
 * name starts with its visible `label`, so voice control can say what it sees.
 */
export const MOMENTS = (() => {
  const moment = (label, name, at, from, to) => ({ label, name, at, from, to });
  const write = timeOf("panel:1:0") - 0.3 * PACE;
  const check = timeOf("check:1:0");
  const commit = timeOf("commit");
  return [
    moment("Read", "show the agent reading the files", timeOf("read:1:1") + 0.5 * PACE, 0, write),
    moment("Write", "show the agent writing the guide", timeOf("panel:1:2") + FORM, write, check),
    moment(
      "Check",
      "show prkit checking each chapter's anchors",
      timeOf("check:1:1") + TICK + 0.2 * PACE,
      check,
      commit,
    ),
    moment(
      "New commit",
      "show a new commit starting revision 2",
      timeOf("back") + STEP_BACK + 0.2 * PACE,
      commit,
      LOOP,
    ),
  ];
})();
