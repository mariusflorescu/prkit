/**
 * The stack figure's dev page, for the anatomy skill's capture, drive and line checks:
 *
 *   node apps/www/src/figures/stack-guides/build.mjs
 *   node <anatomy>/scripts/capture.mjs apps/www/.figures/stack-guides.html --theme light --out ...
 */
import { writeDevPage } from "../kit/prkit-dev.ts";
import { figure } from "./figure.mjs";

writeDevPage({ slug: "stack-guides", card: figure() });
