# Figures

The site's illustrations are isometric figures made with the anatomy skill, drawn at build time
as inline SVG, then moved by a small script once it scrolls near view. Every element is drawn the
way software shows it, made solid: a pull request as a PR window, a diff as rows of raised and
sunk lines, a commit graph, a checks list, the agent as a terminal cursor. Nothing stands in as a
physical object (no trays, rods, gauges or cabinets); UI icons are fine. This folder holds the kit, one folder per figure, and the frame they
share. `sample/` is the reference figure: a dial indicator that exercises every part of the
contract, shown only on the hidden page `/figures/sample`.

## Layout

```
src/figures/
  kit/                 the anatomy kit, vendored unchanged, and prkit's own files next to it
    iso-kit.mjs        camera, solids, parts, SVG renderers (figureSvg, solidSvg, lineSvg, ...)
    lathe.mjs          round parts along any axis
    tube.mjs           pipes and cables
    audit.mjs          the geometry audit (build.mjs --audit)
    iso.css            the kit's part styles
    prkit-theme.css    the kit's tones on prkit's neutrals, light and dark
    prkit-frame.ts     the frame markup, the placeholder, legend()
    prkit-frame.css    the frame's look
    prkit-dev.ts       writeDevPage(): a figure's standalone dev page, and its weight
    prkit-digital.mjs  the digital materials: file diffs, app panels, guide panels, commit graph,
                       checks list, terminal, threads, connectors, the block cursor, and DIGITAL_CSS
    prkit-solid.mjs    a solid whose shape changes as it moves, rewritten in place on the page
  <slug>/              one figure, owned by the unit that draws it
    model.mjs          the pure truth model
    geometry.mjs       static paths, built once with the kit
    figure.mjs         figure(): the card, at build time
    live.js            mount(root): the motion, in the browser
    build.mjs          the dev page for the skill's checks
```

The kit files are copies of the anatomy skill's `kit/` (MIT, credited in
`THIRD_PARTY_NOTICES.md`), each with a header naming its source. Never edit them; lint and format
skip them. Put prkit code next to them. `gl.mjs` comes in only when a figure earns WebGL.

## The contract

### `model.mjs`

The truth. Every number the figure shows (caption, block heights, counts) and every
motion it makes comes from here. Pure functions and constants, no DOM, no kit.

### `geometry.mjs`

Static paths built once with the kit. Export the projection `P` and any path builder that
`live.js` needs per frame (the sample's `needleAt`). `live.js` imports this module in the
browser, so keep module scope cheap: build parts inside functions that only `figure.mjs` calls,
and import only plain JS (`.mjs`/`.js`).

### `figure.mjs`

```js
export function figure(): {
  svg: string;        // k.figureSvg({ width, height, label, body }): role="img" and a plain-words aria-label
  title: string;      // top right of the frame
  hint: string;       // bottom left: how to play with it
  caption: string;    // under the frame
  legend?: string;    // legend([{ mark, label }]) from kit/prkit-frame.ts
  controls?: string;  // HTML of real <button type="button">s, under the drawing
}
```

- Runs at build time only (Astro and Node), so it may import `kit/prkit-frame.ts`.
- No figure numbers, inside or around the figure.
- Words stay in the frame and caption. At most one tiny engraved label in the drawing.
- No live readout: the drawing says its state on its own.
- `controls` is an addition to the original contract. Controls wait hidden (keeping their space)
  until `live.js` has mounted, since they do nothing without it.

### `live.js`

```js
export function mount(root: HTMLElement): () => void
```

Plain browser ESM. `root` is the figure's `<figure data-figure="<slug>">`. The function returns a
cleanup that stops everything it started.

- Find parts with `root.querySelector('[data-part="..."]')`, the drawing's box with
  `[data-stage]`, and controls with `root.querySelectorAll("button[...]")`.
- Move things by writing attributes on those refs (`transform`, `d`, `aria-pressed`), never by
  re-rendering.
- Stop when offscreen: an `IntersectionObserver` on `root`, and no animation frame requested
  while it is out of view.
- Go still under `prefers-reduced-motion: reduce`: no idle tour, and each input snaps straight to
  its result. Follow the media query's `change` event.
- Answer to clicks and keys, through real buttons in `controls`. Nothing reacts to a pointer moving
  over the drawing: no hover, no scrubbing. If the drawing itself takes keys, make it focusable
  (`tabindex`, `role`, `aria-*`) inside `mount`, since it only works with JavaScript.
- Import the kit from `../kit/iso-kit.mjs` (Vite keeps only what you use).

### `build.mjs`

A standalone dev page for the skill's `capture.mjs`, `drive.mjs` and `lines.mjs`:

```js
import { writeDevPage } from "../kit/prkit-dev.ts";
import { figure } from "./figure.mjs";

writeDevPage({ slug: "<slug>", card: figure(), width: 672 }); // 960 for the hero
```

`node apps/www/src/figures/<slug>/build.mjs` writes `apps/www/.figures/<slug>.html` (gitignored)
and prints the drawing's weight against the budget, exiting 1 when over. The page uses the site's
own stylesheet, fonts and frame, mounts `live.js` the way the site does, and follows the system
theme, so pass `--theme light` or `--theme dark` to the skill's scripts. The frame keeps the
kit's `.iso-plate`, so capture and the line check need no `--select`. With no readout, drive.mjs
prints none: to see a figure's state, click its buttons and read `aria-pressed` and the parts'
attributes (`opacity`, `transform`, `visibility`, `data-tone`). Add `--audit` when the figure has
round parts, pipes or cables.

## Sizes

| Slot               | viewBox   | Ratio | Widest on the page                 |
| ------------------ | --------- | ----- | ---------------------------------- |
| Hero (pr-guide)    | 960 × 540 | 16:9  | 60rem (960 px)                     |
| Every other figure | 640 × 480 | 4:3   | the reading column, 42rem (672 px) |

That keeps about one world unit per pixel. Every figure must still read at 390 px wide, where it
draws about 350 px wide. Keep `title` to about 20 characters and `hint` to about 24, so the
corners never meet on a phone.

## Theme

`kit/prkit-theme.css` sets the kit's `--anatomy-*` tones on `:root` from the brand neutrals, light
by default and dark under `prefers-color-scheme: dark`. The ladder follows the kit's own:

| Tone              | Light                                      | Dark                                 |
| ----------------- | ------------------------------------------ | ------------------------------------ |
| paper, card, page | neutral-50                                 | neutral-900 (ink)                    |
| top, face         | paper                                      | ink + 4% paper                       |
| shade 0 to 3      | neutral-200/300 mixes up to neutral-50/100 | ink + 20% black up to ink + 2% paper |
| hi                | neutral-800                                | neutral-200/300                      |
| mid               | neutral-400/500                            | neutral-500/600                      |
| lo                | neutral-300/400                            | neutral-600/700                      |
| faint             | neutral-200/300                            | neutral-700/800                      |
| lit               | rose-700                                   | rose-500                             |

The one lit part is rose. Next to ink or paper, the kit's black or white lit disappears among the
`hi` outlines of the subject; rose finds the eye in both themes. Colour beyond that only when
colour is the subject. Don't use the kit's `.iso` class or `data-theme`: the site follows the
system setting.

## The frame

`Figure.astro` renders a figure as:

```html
<figure class="prk-figure" data-figure="<slug>" [data-live="on"]>
  <div class="iso-plate">
    <!-- hairline, corner ticks, faint dot grid -->
    <div class="iso-plate-corners" aria-hidden="true">
      <span class="iso-plate-corner" data-corner="title">…</span>
      <span class="iso-plate-corner" data-corner="hint">…</span>
    </div>
    <div class="prk-figure-stage" data-stage><svg class="iso-svg" role="img" …></svg></div>
    <div class="prk-figure-controls">…buttons…</div>
  </div>
  <figcaption class="prk-figure-caption">caption, then the legend</figcaption>
</figure>
```

The SVG is inline with its `viewBox`, so the box is the right size from the first paint and
nothing moves when `live.js` arrives. One bundled script in `Figure.astro` watches every figure
and imports its `live.js` (one chunk each) once it comes within a screen of the viewport, calls
`mount(root)` and sets `data-live="on"`.

On the page:

```astro
<Figure slug="inbox-list" />
<Figure
  slug="pr-guide"
  placeholder={{ title: "The guide", caption: "…", ratio: [16, 9] }}
/>
```

`placeholder` holds the slot until the figure's folder exists: the same frame at that ratio, its
caption, and no art. Once `<slug>/figure.mjs` lands it wins and the placeholder is ignored.

## Weight

The inline SVG may weigh at most 250 KB raw and 60 KB gzipped. `writeDevPage` prints both. Over
budget, simplify paths (merge static strokes, round to 0.1), not detail. The sample weighs
85.2 KB raw and 15.8 KB gzipped.

## Accessibility

- The SVG has `role="img"` and an aria-label that says what it shows in plain words.
- Controls are real buttons with names that say what they do.
- The page still reads with figures off: the caption carries the idea.
