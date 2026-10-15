export const TAGLINE = "Stay in the loop when agents write the code.";

export const DESCRIPTION =
  "Agents write more of the code now, and the pull requests arrive faster than anyone can read them. prkit is a local Mac app that keeps you in the loop: every pull request that needs you, across all your GitHub accounts, in one inbox, and a guided review of each one by your own Claude Code, Codex or Cursor.";

// The repository's address comes from GITHUB_URL at build time; see astro.config.ts.
export { GITHUB_URL } from "astro:env/server";

/** The page's sections, in order, for the header and the footer. */
export const SECTIONS = [
  { href: "#what", label: "What it does" },
  { href: "#how-it-works", label: "How it works" },
  { href: "#local", label: "Local first" },
  { href: "#faq", label: "FAQ" },
];
