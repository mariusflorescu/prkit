/**
 * Builds the app icons with iconutil (macOS only). Safe to rerun: it rewrites them.
 *
 *   node scripts/build-icon.ts            build/icon.icns from the brand kit's macOS dark
 *                                         app icon PNGs; every iconset slot has an exact-size
 *                                         PNG in the kit, so nothing is resampled.
 *   node scripts/build-icon.ts --nightly  build/icon-nightly.icns and build/icon-nightly.png:
 *                                         the kit's macOS dark SVG with a crescent moon,
 *                                         rendered at each slot's size in headless Chromium.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { chromium } from "playwright";

const desktopDir = NodePath.resolve(import.meta.dirname, "..");
const appIconDir = NodePath.resolve(desktopDir, "../../assets/brand/app-icon");
const buildDir = NodePath.join(desktopDir, "build");

const { values } = NodeUtil.parseArgs({
  options: { nightly: { type: "boolean", default: false } },
});

const SLOTS = [16, 32, 128, 256, 512].flatMap((size) =>
  [1, 2].map((scale) => ({
    pixels: size * scale,
    name: `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`,
  })),
);

// Brand kit colors only: --prk-warning for the moon, --prk-paper for the stars. The moon
// sits in the panel's top right, clear of the mark, and stays readable at 32px.
const NIGHTLY_OVERLAY = `<defs><mask id="crescent"><rect width="1024" height="1024" fill="#fff"/><circle cx="808" cy="220" r="54" fill="#000"/></mask></defs><circle cx="776" cy="252" r="64" fill="#F0BB3B" mask="url(#crescent)"/><circle cx="694" cy="206" r="8" fill="#FCFAF7" fill-opacity="0.7"/><circle cx="836" cy="356" r="6" fill="#FCFAF7" fill-opacity="0.5"/>`;

const nightlySvg = () => {
  const source = NodeFS.readFileSync(
    NodePath.join(appIconDir, "prkit-icon-macos-dark.svg"),
    "utf8",
  );
  // The kit's provenance metadata is not part of the drawing.
  const drawing = source.replace(/<metadata>[\s\S]*?<\/metadata>/, "");
  return drawing.replace(/<\/svg>\s*$/, `${NIGHTLY_OVERLAY}</svg>`);
};

const renderNightly = async (iconset: string) => {
  const svg = nightlySvg();
  const renders = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "prkit-icon-render-"));
  const rendered = (pixels: number) => NodePath.join(renders, `${pixels}.png`);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    for (const pixels of new Set([...SLOTS.map((slot) => slot.pixels), 1024])) {
      await page.setViewportSize({ width: pixels, height: pixels });
      const sized = svg.replace(
        'width="1024" height="1024"',
        `width="${pixels}" height="${pixels}"`,
      );
      await page.setContent(`<body style="margin:0;background:transparent">${sized}</body>`);
      await page.screenshot({ path: rendered(pixels), omitBackground: true });
    }
    for (const slot of SLOTS)
      NodeFS.copyFileSync(rendered(slot.pixels), NodePath.join(iconset, slot.name));
    // The Dock icon the packaged nightly shows in place of the kit's light and dark ones.
    NodeFS.copyFileSync(rendered(1024), NodePath.join(buildDir, "icon-nightly.png"));
  } finally {
    await browser.close();
    NodeFS.rmSync(renders, { recursive: true, force: true });
  }
};

const copyStable = (iconset: string) => {
  for (const slot of SLOTS) {
    NodeFS.copyFileSync(
      NodePath.join(appIconDir, "png", `prkit-icon-macos-dark-${slot.pixels}.png`),
      NodePath.join(iconset, slot.name),
    );
  }
};

const output = NodePath.join(buildDir, values.nightly ? "icon-nightly.icns" : "icon.icns");
const workDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "prkit-icon-"));
const iconset = NodePath.join(workDir, "icon.iconset");
NodeFS.mkdirSync(iconset);
NodeFS.mkdirSync(buildDir, { recursive: true });
try {
  if (values.nightly) await renderNightly(iconset);
  else copyStable(iconset);
  NodeChildProcess.execFileSync("iconutil", ["--convert", "icns", "--output", output, iconset], {
    stdio: "inherit",
  });
} finally {
  NodeFS.rmSync(workDir, { recursive: true, force: true });
}
process.stdout.write(`wrote ${NodePath.relative(process.cwd(), output)}\n`);
