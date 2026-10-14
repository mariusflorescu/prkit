// The truth behind the inbox list. Every row the figure shows, every count and every pick of the tour comes from
// here, as pure functions.
//
// - Each account runs three GitHub searches (apps/server/src/pullRequests/inboxQuery.ts). A pull request carries
//   every search that found it and shows once, under the strongest, in this order (packages/contracts/src/inbox.ts,
//   inboxReasonPriority; apps/web/src/features/inbox/inboxPresentation.ts, INBOX_GROUPS).
// - A group's header is its title and its count (InboxGroup.tsx). While a filter is on, a group with nothing left
//   is not shown at all (apps/web/src/routes/InboxPage.tsx).
// - The account filter is a select: All accounts, then each login (InboxAccountFilter.tsx). Every row names the
//   account that found it while there is more than one (InboxRow.tsx, showAccount), drawn here as its emblem.
// - A row: the state icon with the checks dot under it, #number, title, a stack mark ("Stack 2/3") or a guide mark
//   ("Writing guide" while the first guide is written, then "Guide ready"), then the author, repository and
//   account, and +additions -deletions on the right (InboxRow.tsx, InboxStackMark.tsx, InboxGuideMark.tsx).
// The example values follow the site's own inbox shot (apps/www/src/assets/shots/inbox-*.webp): two under Needs
// your review, four under Yours with a guide ready and two layers of one stack.

export const GROUPS = [
  { reason: "review-requested", title: "Needs your review" },
  { reason: "authored", title: "Yours" },
  { reason: "involved", title: "Involved" },
];

/** Three gh logins, as the site copy names them, told apart by an emblem's shape. */
export const ACCOUNTS = [
  { name: "work", emblem: "circle" },
  { name: "client", emblem: "square" },
  { name: "personal", emblem: "triangle" },
];

/**
 * Nine example pull requests, in the order the inbox lists them: newest first, a stack's layers together, bottom
 * to top. GitHub's involves:@me matches a PR's author, so every authored PR is also found by Involved and still
 * shows under Yours. `added` and `removed` are the row's +/- counts.
 */
export const PULLS = [
  {
    account: 0,
    reasons: ["review-requested", "involved"],
    checks: "pending",
    mark: "writing",
    added: 1,
    removed: 1,
  },
  { account: 1, reasons: ["review-requested"], checks: "pass", mark: null, added: 0, removed: 0 },
  {
    account: 1,
    reasons: ["authored", "involved"],
    checks: "pass",
    mark: "ready",
    added: 58,
    removed: 9,
  },
  {
    account: 0,
    reasons: ["authored", "involved"],
    checks: "pass",
    mark: "stack",
    layer: 2,
    added: 10,
    removed: 0,
  },
  {
    account: 0,
    reasons: ["authored", "involved"],
    checks: "pending",
    mark: "stack",
    layer: 3,
    added: 9,
    removed: 5,
  },
  {
    account: 2,
    reasons: ["authored", "involved"],
    checks: "pass",
    mark: null,
    added: 4,
    removed: 0,
  },
  { account: 2, reasons: ["involved"], checks: "pass", mark: null, added: 22, removed: 6 },
  { account: 0, reasons: ["involved"], checks: "pass", mark: null, added: 3, removed: 12 },
  { account: 1, reasons: ["involved"], checks: null, mark: null, added: 7, removed: 2 },
];

const rank = (reason) => GROUPS.findIndex((group) => group.reason === reason);

/** The group a pull request shows under: its strongest reason. */
export const groupOf = (pull) => Math.min(...pull.reasons.map(rank));

/** Each group's pull requests, as indexes into PULLS, in list order. */
export const MEMBERS = GROUPS.map((_, group) =>
  PULLS.flatMap((pull, index) => (groupOf(pull) === group ? [index] : [])),
);

/** Whether a row is listed under a choice: null is All accounts. */
export const listed = (index, choice) => choice === null || PULLS[index].account === choice;

/** What each row and each group is aiming for under a choice: 1 shown, 0 gone. */
export function targetsOf(choice) {
  const rows = PULLS.map((_, index) => (listed(index, choice) ? 1 : 0));
  // With a filter on, a group with nothing left goes away, header and all.
  const groups = MEMBERS.map((members) =>
    choice === null || members.some((index) => rows[index]) ? 1 : 0,
  );
  return { rows, groups };
}

// ---------------------------------------------------------------------------------------------------------------
// Motion. A pick plays the way the app's select does it: the popup opens, the highlight moves to the account, the
// check lands on it and the popup closes, then every group narrows to that account's rows at once.

const clamp01 = (value) => Math.min(1, Math.max(0, value));
/** Smootherstep: zero speed and acceleration at both ends. */
export const ease = (value) => {
  const u = clamp01(value);
  return u * u * u * (u * (u * 6 - 15) + 10);
};
const span = (t, from, to) => ease((t - from) / (to - from));
const mix = (a, b, share) => a + (b - a) * share;

/** A pick's beats, in seconds from its start. */
export const PICK = {
  open: 0.24,
  hover: [0.26, 0.56],
  check: 0.6,
  close: [0.65, 0.86],
  narrow: [0.75, 1.39],
};
export const PICK_LENGTH = PICK.narrow[1];

/** The popup's rows: All accounts first, then each account. */
export const itemOf = (choice) => (choice === null ? 0 : choice + 1);

/**
 * The figure `u` seconds into a pick from `from` (a state as this returns it) to the choice `to`. Rows and groups
 * ease from wherever they were, so a pick made mid-way through another one carries on smoothly.
 */
export function pickAt(u, from, to) {
  const aim = targetsOf(to);
  const narrow = span(u, ...PICK.narrow);
  const open =
    Math.max(from.popup * (1 - span(u, 0, PICK.open)), span(u, 0, PICK.open)) *
    (1 - span(u, ...PICK.close));
  return {
    choice: u >= PICK.check ? to : from.choice,
    rows: from.rows.map((value, index) => mix(value, aim.rows[index], narrow)),
    groups: from.groups.map((value, index) => mix(value, aim.groups[index], narrow)),
    popup: open,
    hover: mix(from.hover, itemOf(to), span(u, ...PICK.hover)),
  };
}

/** A choice at rest. */
export function restOf(choice) {
  const { rows, groups } = targetsOf(choice);
  return { choice, rows, groups, popup: 0, hover: itemOf(choice) };
}

/** The tour: all accounts, then each account in turn, then all again. Each step is a pick and a hold. */
export const TOUR = [0, 1, 2, null];
export const HOLD = 1.4;
const STEP = PICK_LENGTH + HOLD;
/** It opens on all accounts, at rest, for this long. */
export const LEAD = 1.4;
export const LOOP = LEAD + STEP * TOUR.length;

/** The whole figure at tour time t. */
export function tourAt(time) {
  const t = ((time % LOOP) + LOOP) % LOOP;
  if (t < LEAD) return restOf(null);
  const step = Math.min(TOUR.length - 1, Math.floor((t - LEAD) / STEP));
  const before = step === 0 ? null : TOUR[step - 1];
  return pickAt(t - LEAD - step * STEP, restOf(before), TOUR[step]);
}
