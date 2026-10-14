/**
 * The hero's dev page, for the anatomy skill's capture and line checks:
 *
 *   node apps/www/src/figures/pr-guide/build.mjs           writes apps/www/.figures/pr-guide.html
 *   node apps/www/src/figures/pr-guide/build.mjs --audit   checks the drawing's geometry instead
 */
import { auditOrExit } from "../kit/audit.mjs";
import { writeDevPage } from "../kit/prkit-dev.ts";
import { figure } from "./figure.mjs";
import { P, drawing } from "./geometry.mjs";

if (process.argv.includes("--audit")) auditOrExit(drawing().R, P);
else writeDevPage({ slug: "pr-guide", card: figure(), width: 960 });
