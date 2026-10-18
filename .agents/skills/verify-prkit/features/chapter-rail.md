# Chapter rail

Beside every guide, in its left gutter, a thin sticky column of ticks, one per chapter in reading order. Length says where you are (the chapter at the reading line, or the one you just jumped to at the end of the guide), color says what you ticked (unreviewed, partly reviewed, reviewed, changed since you reviewed), and a small gap says the guide moved to another band of chapters. A dot before a tick says the agent rated the chapter Medium or High. Generated chapters, prkit's "Skipped by your ignore rules" included, get a shorter, quieter tick. Hover or keyboard focus shows the chapter's number, title, kind, risk and progress; a click jumps to it. The roadmap in the overview stays the table of contents. The rail reads only GuideView's own props, so the Guide tab, a draft and the DEV fixtures all show it.

## Sub-features

- `rail-ticks` is `navigation "Chapters"` holding one `button` per chapter, named like `Chapter 3 of 7, A column for slugs, reviewed` (`, 1 of 2 files reviewed`, `, 1 file changed since you reviewed`, `, being written`, nothing extra when nothing can be ticked, `, high risk` when rated). `data-state` is `unreviewed`, `partial`, `reviewed`, `changed`, `pending` or `unmarked`; generated chapters carry `data-quiet`. The rail shows from two chapters up.
- `rail-gaps` puts `li[data-gap]` where the band changes: core and supporting, data and config, tests and docs, generated. prkit tells agents to order chapters core, supporting, data, config, tests, docs, generated, so a guide gets at most three gaps.
- `rail-current` marks the chapter being read with `aria-current="location"`: the last chapter whose top reached the reading line (under the pinned header), none in the overview. At the end of the guide, where the last chapters can't reach the line, the chapter last jumped to (rail, roadmap, j/k, flow links) holds it until the reader scrolls by hand.
- `rail-keys` keeps `j`/`k` on the same answer, so repeated `j` at the end walks to the last chapter, and `r` ticks the chapter a tick click focused. The rail has one tab stop; ArrowUp, ArrowDown, Home and End move between ticks, Enter jumps. Typing `j` in a comment field never moves the guide.
- `rail-tooltip` is `[data-slot="tooltip-popup"]`: `01  Limits get a slug`, then `Core · 1 of 2 reviewed` (`Being written`, `Core · 1 changed since you reviewed`, with the risk level when rated).
- `rail-narrow` hides the rail at 700px and narrower, where the roadmap and j/k remain. Between 700 and 1100px it sits in the narrower gutter.
- `rail-dock` keeps the rail and the `r` key above `--pr-covered-bottom`, which a dock at the bottom of the Guide tab sets.

## How to get to it (user POV)

- Open a PR with a guide and choose `Guide`; the rail sits at the left of the guide.
- Run `pnpm dev` and open `/dev/guide/vercel-ai-22182` for a real guide with many chapters (no reviewed state there).

## Driving it with e2e

Preconditions:

- `pnpm build` ran after the last change. `tests/guide-rail.e2e.ts` starts its own instance on the fake GitHub with the stand-in Claude and the local git fixture, so it needs no fixture repository and spends no subscription.
- `git.commit(9, files)` adds the files, `fake.gitHead(9, sha)` makes them GitHub's head, and `claude.chapters([{ title, kind, paths }])` makes the stand-in write those chapters in that order.

- **Ticks.** Seven chapters, one per band and kind: `rail.getByRole("button")` has 7, `li[data-gap]` sit before ticks 3, 5 and 7, tick 7 has `data-quiet`, and no tick has `aria-current` in the overview.
- **Click and keys.** Tap tick 3: it becomes current and its chapter takes focus. `j` makes tick 4 current, `k` tick 3, `r` ticks `checkbox "Reviewed chapter A column for slugs"` and the tick reads `data-state="reviewed"`.
- **Partial and tooltip.** Tap tick 1, tick `checkbox "Reviewed src/check.ts"`: tick 1 reads `partial` and its name ends `1 of 2 files reviewed`. Hover it: the tooltip reads `Limits get a slug` and `Core · 1 of 2 reviewed`.
- **Scroll.** Scroll `[data-pr-scroll]` so chapter 2 sits at the reading line: tick 2 is current.
- **End.** Tap tick 6, then `j`: tick 7 is current although the guide ends before it reaches the line; `j` again keeps it; `k` goes back to 6.
- **Rail keys.** Focus tick 6, ArrowUp, Home, End move focus; ArrowUp then Enter jumps to Docs.
- **Widths.** At 900px a tick is visible; at 680px it is hidden; back at 1280px it shows again.
- **Proof.** `pnpm e2e run tests/guide-rail.e2e.ts --output .e2e/proof/<name>` saves `rail-overview`, `rail-partial-tooltip` and `rail-900` in light and dark, `rail-end-of-guide` and `rail-680-hidden`.

## Gotchas

- The rail's `nav` is sticky with no height of its own (the ticks hang off it), so `toBeVisible` on it fails; check a tick.
- The jump focuses its chapter on the next frame, after `aria-current` may already read right: poll the focused chapter.
- Tick widths ease over 120ms, so a frame taken right after a key can catch two ticks mid-way.
