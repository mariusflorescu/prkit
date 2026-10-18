import { FIXTURE_REPO } from "./fixturePr.ts";
import { gh, putFile, waitForPullRef } from "./reviewFixture.ts";

/** A long class whose methods hold loops and branches, so a one-line hunk sits deep inside. */
const ROUTER = `// Routes requests to handlers. Each route has a method, a path pattern and a handler.
export class Router {
  constructor() {
    this.routes = [];
    this.middleware = [];
  }

  use(fn) {
    this.middleware.push(fn);
    return this;
  }

  add(method, pattern, handler) {
    const keys = [];
    const source = pattern
      .split("/")
      .map((part) => {
        if (!part.startsWith(":")) return part;
        keys.push(part.slice(1));
        return "([^/]+)";
      })
      .join("/");
    this.routes.push({ method, keys, regex: new RegExp(\`^\${source}$\`), handler });
    return this;
  }

  async handle(req, res) {
    for (const fn of this.middleware) {
      const stop = await fn(req, res);
      if (stop) return;
    }
    const url = new URL(req.url, "http://localhost");
    for (const route of this.routes) {
      if (route.method !== req.method) continue;
      const match = route.regex.exec(url.pathname);
      if (match) {
        const params = {};
        route.keys.forEach((key, index) => {
          params[key] = decodeURIComponent(match[index + 1]);
        });
        req.params = params;
        req.query = Object.fromEntries(url.searchParams);
        req.startedAt = Date.now();
        res.setHeader("cache-control", "no-store");
        res.setHeader("x-route", route.regex.source);
        const timer = setTimeout(() => res.writeHead(504).end(), 10_000);
        try {
          await route.handler(req, res);
        } catch (error) {
          res.writeHead(500, { "content-type": "text/plain" });
          res.end("Something went wrong");
          console.error(error);
        } finally {
          clearTimeout(timer);
        }
        return;
      }
    }
    res.writeHead(404).end();
  }

  list() {
    return this.routes.map((route) => \`\${route.method} \${route.regex.source}\`);
  }
}
`;

/** The head's one change in the router: a line deep in `handle`, far below its openers. */
const ROUTER_HEAD = ROUTER.replace(
  'res.setHeader("cache-control", "no-store");',
  'res.setHeader("cache-control", "private, no-store");',
);

const NORMALIZE_BODY = `  const trimmed = input.trim();
  if (trimmed === "") return null;
  const withScheme = /^[a-z]+:\\/\\//i.test(trimmed) ? trimmed : \`https://\${trimmed}\`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  url.hostname = url.hostname.toLowerCase();
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const defaultPort =
    (url.protocol === "https:" && url.port === "443") ||
    (url.protocol === "http:" && url.port === "80");
  if (defaultPort) url.port = "";
  url.hash = "";
  const params = [...url.searchParams.entries()]
    .filter(([key]) => !key.startsWith("utm_"))
    .sort(([a], [b]) => a.localeCompare(b));
  url.search = "";
  for (const [key, value] of params) url.searchParams.append(key, value);
  const text = url.toString();
  return text.length > MAX_URL_LENGTH ? null : text;
`;

const SLUGIFY = `export function slugify(title) {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\\u0300-\\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}
`;

const DESCRIBE = `export function describeLink(link) {
  const host = new URL(link.url).hostname;
  const created = new Date(link.createdAt).toISOString().slice(0, 10);
  return \`\${link.code} goes to \${host}, made on \${created}\`;
}
`;

const LINKS = `// Helpers for the links a user shortens.
export const MAX_URL_LENGTH = 2048;

export function normalizeUrl(input) {
${NORMALIZE_BODY}}

${SLUGIFY}
${DESCRIBE}`;

/** \`normalizeUrl\` left for its own module. */
const LINKS_HEAD = `// Helpers for the links a user shortens.
export const MAX_URL_LENGTH = 2048;

${SLUGIFY}
${DESCRIBE}`;

const indent = (text: string) =>
  text
    .split("\n")
    .map((line) => (line === "" ? line : `  ${line}`))
    .join("\n");

/** The moved function, two spaces deeper inside an object, with one line changed on the way. */
const URLS = `import { MAX_URL_LENGTH } from "./links.js";

// Everything about the URLs a user hands in.
export const urls = {
  normalize(input) {
${indent(NORMALIZE_BODY).replace('!key.startsWith("utm_")', '!key.startsWith("utm_") && key !== "fbclid"')}  },

  isWeb(url) {
    return url.protocol === "https:" || url.protocol === "http:";
  },
};
`;

const FORMAT_ROW = `function formatRow(link, count) {
  const code = link.code.padEnd(10, " ");
  const clicksText = String(count).padStart(6, " ");
  const url = link.url.length > 60 ? \`\${link.url.slice(0, 57)}...\` : link.url;
  return \`\${code}  \${clicksText}  \${url}\`;
}
`;

const REPORT_REST = `// Builds the plain-text click report.
export function buildReport(links, clicks) {
  const rows = links.map((link) => formatRow(link, clicks.get(link.code) ?? 0));
  return [header(), ...rows, "", \`\${totalClicks(clicks)} clicks in all\`].join("\\n");
}

function header() {
  return "code        clicks  url";
}

export function totalClicks(clicks) {
  let total = 0;
  for (const count of clicks.values()) total += count;
  return total;
}
`;

const REPORT = `${REPORT_REST}
${FORMAT_ROW}`;
/** `formatRow` moved above its caller, unchanged. */
const REPORT_HEAD = `${FORMAT_ROW}
${REPORT_REST}`;

/** The base branch's files and what the head changes them to. */
export const SMARTER_DIFF_FILES = {
  base: { "src/router.js": ROUTER, "src/links.js": LINKS, "src/report.js": REPORT },
  head: {
    "src/urls.js": URLS,
    "src/links.js": LINKS_HEAD,
    "src/report.js": REPORT_HEAD,
    "src/router.js": ROUTER_HEAD,
  },
};

/** What the stand-in agent's fix writes: `describeLink` moves into the report, and the router's 404 line changes. */
export const FIX_EDITS = {
  "src/links.js": LINKS_HEAD.replace(`\n${DESCRIBE}`, ""),
  "src/report.js": `${REPORT_HEAD}\n${DESCRIBE}`,
  "src/router.js": ROUTER_HEAD.replace(
    "res.writeHead(404).end();",
    'res.writeHead(404, { "content-type": "text/plain" }).end("No such link");',
  ),
};

const lineOf = (text: string, needle: string) =>
  text.split("\n").findIndex((line) => line.includes(needle)) + 1;

/** Where the head's moves and hunks sit, read from the files above rather than typed by hand. */
export const SMARTER_DIFF = {
  links: "src/links.js",
  urls: "src/urls.js",
  report: "src/report.js",
  router: "src/router.js",
  /** Where `normalizeUrl`'s body was cut (old side) and where it landed (new side): its signature changed. */
  cutAt: lineOf(LINKS, "const trimmed = input.trim();"),
  landedAt: lineOf(URLS, "const trimmed = input.trim();"),
  /** The one line of the moved body that changed on the way, and a plain addition above it. */
  editedAt: lineOf(URLS, 'key !== "fbclid"'),
  addedAt: lineOf(URLS, "import { MAX_URL_LENGTH }"),
  /** `formatRow`, moved to the top of the report without a change. */
  rowCutAt: lineOf(REPORT, "function formatRow"),
  rowLandedAt: lineOf(REPORT_HEAD, "function formatRow"),
  /** The router's changed line, and the openers above it that no hunk shows. */
  routerChange: lineOf(ROUTER_HEAD, "private, no-store"),
  routerScope: [
    "export class Router {",
    "async handle(req, res) {",
    "for (const route of this.routes) {",
    "if (match) {",
  ],
} as const;

export type SmarterDiffFixture = {
  readonly base: string;
  readonly branch: string;
  readonly number: number;
};

/**
 * Opens a PR of its own on the fixture repo, from a head branch onto a base branch it also makes,
 * so the base holds long functions the head only touches in one line.
 */
export const createSmarterDiffFixture = (stamp: string): SmarterDiffFixture => {
  const base = `e2e/smarter-diff-base-${stamp}`;
  const branch = `e2e/smarter-diff-${stamp}`;
  const sha = (ref: string) =>
    gh(["api", `repos/${FIXTURE_REPO}/git/ref/heads/${ref}`, "--jq", ".object.sha"]).trim();
  const branchFrom = (name: string, from: string) =>
    gh([
      "api",
      "-X",
      "POST",
      `repos/${FIXTURE_REPO}/git/refs`,
      "-f",
      `ref=refs/heads/${name}`,
      "-f",
      `sha=${sha(from)}`,
    ]);
  branchFrom(base, "main");
  for (const [path, content] of Object.entries(SMARTER_DIFF_FILES.base))
    putFile(base, path, content, `feat: add ${path}`);
  branchFrom(branch, base);
  for (const [path, content] of Object.entries(SMARTER_DIFF_FILES.head))
    putFile(branch, path, content, `refactor: change ${path}`);
  const number = Number(
    gh([
      "api",
      "-X",
      "POST",
      `repos/${FIXTURE_REPO}/pulls`,
      "-f",
      `title=Smarter diff fixture ${stamp}`,
      "-f",
      `head=${branch}`,
      "-f",
      `base=${base}`,
      "-f",
      "body=Opened by the smarter diff journey. It closes itself when the run ends.",
      "--jq",
      ".number",
    ]).trim(),
  );
  waitForPullRef(number);
  return { base, branch, number };
};

export const closeSmarterDiffFixture = (fixture: SmarterDiffFixture) => {
  gh(["pr", "close", String(fixture.number), "-R", FIXTURE_REPO, "--delete-branch"]);
  gh(["api", "-X", "DELETE", `repos/${FIXTURE_REPO}/git/refs/heads/${fixture.base}`]);
};
