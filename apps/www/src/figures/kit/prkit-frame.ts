/**
 * The frame every figure sits in, as one HTML string, so Figure.astro and the figures' dev pages
 * (prkit-dev.ts) render exactly the same markup. It keeps the kit's plate classes (`.iso-plate`,
 * `.iso-plate-corner`), so the anatomy skill's capture and line checks find the figure on the
 * site without a selector. prkit-frame.css gives it prkit's look.
 */

/** What a figure's `figure()` returns. Every string except the HTML ones is plain text. */
export interface FigureCard {
  /** The drawing: `figureSvg(...)` from the kit, with role="img" and a plain-words aria-label. */
  readonly svg: string;
  /** Top right of the frame. */
  readonly title: string;
  /** Bottom left of the frame: how to play with it. */
  readonly hint: string;
  /** Under the frame. */
  readonly caption: string;
  /** Under the caption: the HTML from `legend()`. */
  readonly legend?: string;
  /** Under the drawing: HTML of real `<button type="button">`s, shown once live.js has mounted. */
  readonly controls?: string;
}

/** A slot whose figure has not landed yet: a calm frame of the right shape, and its caption. */
export interface FigurePlaceholder {
  readonly title: string;
  readonly caption: string;
  /** Width over height of the drawing: 16 / 9 for the hero, 4 / 3 for the rest. */
  readonly ratio: readonly [number, number];
}

/** One legend key: a kit swatch and what it marks. */
export interface LegendKey {
  readonly mark: "raised" | "flat" | "lit" | "dim" | "dotted" | "dashed";
  readonly label: string;
}

const escape = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const corner = (name: string, text: string): string =>
  `<span class="iso-plate-corner" data-corner="${name}">${escape(text)}</span>`;

const shell = ({
  slug,
  title,
  hint,
  stage,
  controls,
  caption,
  legend,
}: {
  slug: string;
  title: string;
  hint: string;
  stage: string;
  controls: string;
  caption: string;
  legend: string;
}): string =>
  `<figure class="prk-figure" data-figure="${escape(slug)}">` +
  `<div class="iso-plate">` +
  `<div class="iso-plate-corners" aria-hidden="true">` +
  (title ? corner("title", title) : "") +
  (hint ? corner("hint", hint) : "") +
  `</div>` +
  stage +
  (controls ? `<div class="prk-figure-controls">${controls}</div>` : "") +
  `</div>` +
  `<figcaption class="prk-figure-caption">` +
  `<span class="prk-figure-text">${escape(caption)}</span>` +
  legend +
  `</figcaption>` +
  `</figure>`;

/** A finished figure in its frame. */
export const frameHtml = ({ slug, card }: { slug: string; card: FigureCard }) =>
  shell({
    slug,
    title: card.title,
    hint: card.hint,
    stage: `<div class="prk-figure-stage" data-stage>${card.svg}</div>`,
    controls: card.controls ?? "",
    caption: card.caption,
    legend: card.legend ?? "",
  });

/** The empty frame that holds a figure's place until it lands. */
export const placeholderHtml = ({
  slug,
  placeholder,
}: {
  slug: string;
  placeholder: FigurePlaceholder;
}) =>
  shell({
    slug,
    title: placeholder.title,
    hint: "",
    stage: `<div class="prk-figure-stage" data-placeholder style="aspect-ratio:${placeholder.ratio[0]} / ${placeholder.ratio[1]}" role="img" aria-label="${escape(`${placeholder.title}: the illustration is on its way.`)}"></div>`,
    controls: "",
    caption: placeholder.caption,
    legend: "",
  });

// Adapted from the anatomy skill's kit/iso-kit.mjs (swatchSvg and plateHtml's keys), which does not
// export them. The swatches are styled by kit/iso.css.
const swatch = (mark: LegendKey["mark"]): string => {
  if (mark === "raised" || mark === "flat" || mark === "lit") {
    const body =
      mark === "flat" ? "M2 6.5 8 3.5 14 6.5 8 9.5Z" : "M2 4.5 8 1.5 14 4.5 14 6 8 9 2 6Z";
    const crease =
      mark === "flat" ? "" : `<path class="iso-swatch-crease" d="M2 4.5 8 7.5 14 4.5"/>`;
    return `<svg class="iso-swatch" data-mark="${mark}" viewBox="0 0 16 10" aria-hidden="true"><path d="${body}"/>${crease}</svg>`;
  }
  return `<svg class="iso-swatch" data-mark="${mark}" viewBox="0 0 16 10" aria-hidden="true"><path d="M1.5 5h13"/></svg>`;
};

/** The legend under a figure: one kit swatch per key, then what it marks. */
export const legend = (keys: ReadonlyArray<LegendKey>): string =>
  `<span class="iso-keys">${keys
    .map((key) => `<span class="iso-key">${swatch(key.mark)}${escape(key.label)}</span>`)
    .join("")}</span>`;
