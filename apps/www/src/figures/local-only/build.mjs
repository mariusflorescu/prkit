/**
 * The local-first figure's dev page, for the anatomy skill's capture, drive and line checks:
 *
 *   node apps/www/src/figures/local-only/build.mjs
 *   node <anatomy>/scripts/capture.mjs apps/www/.figures/local-only.html --theme light --out ...
 */
import { writeDevPage } from "../kit/prkit-dev.ts";
import { figure } from "./figure.mjs";

writeDevPage({ slug: "local-only", card: figure() });
