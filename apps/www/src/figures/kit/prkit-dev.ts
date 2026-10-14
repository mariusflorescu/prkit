/**
 * A figure's standalone dev page, for the anatomy skill's capture.mjs, drive.mjs and lines.mjs.
 * It renders the same frame as the site (prkit-frame.ts) with the site's own styles and fonts,
 * mounts live.js the way Figure.astro does, and follows the system theme, so the skill's
 * `--theme light|dark` flag picks the theme. Pages go to the gitignored apps/www/.figures/.
 *
 *   node src/figures/<slug>/build.mjs   ->   apps/www/.figures/<slug>.html
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { type FigureCard, frameHtml } from "./prkit-frame.ts";

const WWW = fileURLToPath(new URL("../../../", import.meta.url));
const OUT = join(WWW, ".figures");

/** The most a figure's inline SVG may weigh, raw and gzipped. */
const BUDGET = { raw: 250 * 1024, gzip: 60 * 1024 };

const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;

/** What a figure's drawing adds to the page, raw and gzipped. */
export const weightOf = (svg: string) => ({
  raw: Buffer.byteLength(svg),
  gzip: gzipSync(svg).length,
});

/**
 * Writes the dev page and prints the drawing's weight against the budget. `width` is the widest
 * the page shows the figure: 42rem (672) in the reading column, 60rem (960) for the hero.
 */
export function writeDevPage({
  slug,
  card,
  width = 672,
}: {
  slug: string;
  card: FigureCard;
  width?: number;
}): string {
  mkdirSync(OUT, { recursive: true });
  const from = (path: string) => relative(OUT, join(WWW, path));
  const font = (family: string, name: string, weight: number) =>
    `@font-face{font-family:"${name}";font-weight:${weight};font-display:block;src:url("${from(`node_modules/@fontsource/${family}/files/${family}-latin-${weight}-normal.woff2`)}") format("woff2")}`;
  const styles = [
    "src/styles/global.css",
    "src/figures/kit/iso.css",
    "src/figures/kit/prkit-theme.css",
    "src/figures/kit/prkit-frame.css",
  ];
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Figure: ${slug}</title>
<style>
${font("fira-sans", "Fira Sans", 400)}
${font("fira-sans", "Fira Sans", 500)}
${font("fira-sans", "Fira Sans", 600)}
${font("jetbrains-mono", "JetBrains Mono", 400)}
:root{--font-sans:"Fira Sans",sans-serif;--font-mono:"JetBrains Mono",monospace}
.dev{width:min(100% - 2 * var(--gutter),${width}px);margin:4rem auto 80vh}
</style>
${styles.map((path) => `<link rel="stylesheet" href="${from(path)}">`).join("\n")}
</head>
<body>
<main class="dev">${frameHtml({ slug, card })}</main>
<script type="module">
import { mount } from "${from(`src/figures/${slug}/live.js`)}";
const root = document.querySelector("[data-figure]");
mount(root);
root.dataset.live = "on";
</script>
</body>
</html>
`;
  const file = join(OUT, `${slug}.html`);
  writeFileSync(file, html);
  const weight = weightOf(card.svg);
  const over = weight.raw > BUDGET.raw || weight.gzip > BUDGET.gzip;
  console.log(
    `wrote ${relative(process.cwd(), file)} · svg ${kb(weight.raw)} raw, ${kb(weight.gzip)} gzip (budget ${kb(BUDGET.raw)}, ${kb(BUDGET.gzip)})`,
  );
  if (over) {
    console.error("over the weight budget: simplify paths (merge static strokes, round to 0.1)");
    process.exitCode = 1;
  }
  return file;
}
