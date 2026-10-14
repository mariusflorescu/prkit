/**
 * The sample figure's dev page, for the anatomy skill's capture, drive and line checks:
 *
 *   node apps/www/src/figures/sample/build.mjs
 *   node <anatomy>/scripts/capture.mjs apps/www/.figures/sample.html --theme light --out ...
 */
import { writeDevPage } from "../kit/prkit-dev.ts";
import { figure } from "./figure.mjs";

writeDevPage({ slug: "sample", card: figure() });
