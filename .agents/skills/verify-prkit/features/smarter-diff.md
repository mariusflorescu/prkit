# Smarter diffs

Every diff prkit shows (the Files tab, the guide's chapters, a fix turn's changes) reads moved code as a move and names the code around each hunk. Lines cut from one place and pasted in another, in the same file or another one, with their indentation and spacing changed or not, render in a soft info tint instead of red and green, and a chip sits above each end: `Moved from src/links.js · 22 lines` above where it landed, `Moved to src/urls.js · 22 lines` above where it was cut, `Moved from line 17` inside one file. The path is a button to the other end. A line that changed on the way keeps its red or green. The row above a hunk that already says "40 unmodified lines" also names the function, class, loop or branch the hunk sits in, once prkit has read the new side of the file: `export class Router { › … › for (const route of this.routes) { › if (match) {`. Nothing is added to the page when that text arrives. How the reads stay on the right account and budget is in docs/internals/architecture.md, "GitHub reads".

## Sub-features

- `moves-chips` puts `button "Show src/links.js lines 5-27"` in the landed end's chip and `button "Show src/urls.js lines 6-28"` in the cut end's, under the row right above each block, in the card's `region` named by its path. A chip whose other end no place shows (a guide draft without that file) is plain text.
- `moves-quiet` gives the moved rows the info tint by line type and number (`[data-line][data-line-type="change-addition"][data-line="6"]` has another background than a plain addition), keeps pierre's word highlights, and leaves edited lines red or green.
- `moves-jump` opens the other card, mounts its lazy diff, scrolls the other end to the middle and highlights the whole block (`data-selected-line` on its rows). In the guide it first opens the chapter that holds the file, even one the reader closed.
- `scope-row` writes `[data-scope]` into the 24 px separator row in the gutter's copy of the separator: unified, or split's left column. Three openers or fewer read in full; deeper reads the outermost, `…`, and the last two. The separator's title lists every opener with its line. An opener the hunk just above already shows is left out, and expanding unchanged lines drops the openers that came into view.
- `scope-reads` reads the new side of every changed-in-place file whose hunks have hidden lines above them, in batches of 50: on the Files tab one GraphQL request per batch through the PR's account, in the background (`graphql:texts` on the fake GitHub); for a guide attempt and a fix turn from prkit's own copy of the repository, with no GitHub request. A failed read shows one line at the top of the list, `Couldn't read the code around each change.` with the server's words and `button "Retry"`; moves and changed lines stay.

## How to get to it (user POV)

- Open any PR's Files tab, a guide's chapter, or a ready fix in the Fixes tab.

## Driving it with e2e

Preconditions:

- `pnpm build` ran after the last change. `tests/smarter-diff.e2e.ts` drives the real fixture repository, so it runs through the fixture lock: `/tmp/prkit-cos/with-fixture-lock.sh <branch> pnpm e2e run tests/smarter-diff.e2e.ts`. It opens a PR of its own (`createSmarterDiffFixture` in `tests/smarterDiffFixture.ts`) from a head branch onto a base branch it also makes, so the base holds a long `Router` class the head touches in one line, and closes both when it ends. The guide and the fix come from the stand-in Claude (`claude.chapters(...)` splits its guide, `claude.edits(FIX_EDITS)` has its fix move `describeLink` and change a line deep in `handle`), so it spends no subscription.
- `tests/diff-timing.e2e.ts` needs only the fake GitHub (`fake.files(9, ...)` and `fake.texts(9, ...)` seed a 200-file diff from `tests/largeDiffFixture.ts`), so it needs no lock. It writes its numbers to `.e2e/evidence/diff-timing/<DIFF_TIMING_LABEL>-<time>.json`.

- **Files.** The chips in `src/urls.js`, `src/links.js` and `src/report.js`; the moved row's background against a plain addition's and the edited line's; a tap on the chip lands on the cut's old line 5, highlighted and in view, and back. `src/router.js`'s separator reads the four openers as `outer › … › for › if`, stays 24 px high, and its title holds all four; split view writes the same label in its left column; a tap on the row expands the 40 lines above, which puts every opener on the page, and the row goes. Then a 800 px window.
- **Guide.** `button "Generate guide"` with two chapters; close "The rest of the refactor", tap the chip in `src/urls.js`: the chapter opens and the cut is highlighted in view. The router's separator names its scope, read from the attempt's head in the repository cache.
- **Fixes.** A draft on the router's changed line, Send to agent, the stand-in's fix: its diff shows the `describeLink` move between `src/links.js` and `src/report.js` and `export class Router { › async handle(req, res) {` above the 404 line, read from the unpushed commit.
- **Timing.** `DIFF_TIMING_LABEL=<build> pnpm e2e run tests/diff-timing.e2e.ts` on this build and on a build of the commit before (a throwaway worktree with the journey, its fixture and the fake copied in) gives time to the first and tenth painted diff, long tasks until then, the time to scroll all 200 cards and the long tasks while scrolling, and how many scope rows were painted.
- Frames from the journey, light and dark: `files-moved-from`, `files-jumped-to-cut`, `files-scope`, `files-scope-expanded`, `files-moved-split`, `files-moved-narrow`, `guide-jumped-to-cut`, `guide-scope`, `fixes-moved-and-scope`.

## Gotchas

- The diff's rows live in Pierre's shadow root. Read them with `browser.evaluate` through `[data-path="<path>"] diffs-container`'s `shadowRoot`, or with a `browser.locator` whose selector pierces it.
- Pierre draws each separator twice, in the gutter and in the content column, and hides the content column's copy; the scope text is in the gutter's.
- A move needs at least three non-blank lines and enough code to weigh 40 letters, digits and underscores; a shorter one stays red and green on purpose.
