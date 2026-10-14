/**
 * The fix figure's dev page, for the anatomy skill's capture, drive and line checks:
 *
 *   node apps/www/src/figures/fix-commit/build.mjs   ->   apps/www/.figures/fix-commit.html
 */
import { writeDevPage } from "../kit/prkit-dev.ts";
import { figure } from "./figure.mjs";

writeDevPage({ slug: "fix-commit", card: figure() });
