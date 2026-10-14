/**
 * The inbox list's dev page, for the anatomy skill's capture, drive and line checks:
 *
 *   node apps/www/src/figures/inbox-list/build.mjs   ->   apps/www/.figures/inbox-list.html
 */
import { writeDevPage } from "../kit/prkit-dev.ts";
import { figure } from "./figure.mjs";

writeDevPage({ slug: "inbox-list", card: figure() });
