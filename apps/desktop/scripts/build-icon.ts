/**
 * Builds build/icon.icns from the brand kit's macOS dark app icon PNGs with
 * iconutil (macOS only). Every iconset slot has an exact-size PNG in the kit,
 * so nothing is resampled. Safe to rerun: it rewrites the .icns.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const desktopDir = NodePath.resolve(import.meta.dirname, "..");
const pngDir = NodePath.resolve(desktopDir, "../../assets/brand/app-icon/png");
const output = NodePath.join(desktopDir, "build/icon.icns");

const workDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "prkit-icon-"));
const iconset = NodePath.join(workDir, "icon.iconset");
NodeFS.mkdirSync(iconset);
try {
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      NodeFS.copyFileSync(
        NodePath.join(pngDir, `prkit-icon-macos-dark-${size * scale}.png`),
        NodePath.join(iconset, `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`),
      );
    }
  }
  NodeFS.mkdirSync(NodePath.dirname(output), { recursive: true });
  NodeChildProcess.execFileSync("iconutil", ["--convert", "icns", "--output", output, iconset], {
    stdio: "inherit",
  });
} finally {
  NodeFS.rmSync(workDir, { recursive: true, force: true });
}
process.stdout.write(`wrote ${NodePath.relative(process.cwd(), output)}\n`);
