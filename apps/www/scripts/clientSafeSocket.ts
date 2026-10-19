/**
 * The GitHub accounts on a developer's machine see client pull requests, and their logins,
 * names and avatars are real people. Every RPC frame from the server passes through this
 * filter before the page sees it: pull requests outside the fixture repository are dropped,
 * and every login, name, avatar and the home path is swapped for a placeholder. Requests from
 * the page get the real names back, so the server never sees a placeholder. Whatever it drops
 * or replaces is remembered, and `assertClean` fails a shot if any of it still reaches the page.
 *
 * Nobody but the fixture's owner opens pull requests on the fixture, so nothing in it asks for
 * the owner's review. The pull requests in `reviewRequests` reach the page as a teammate's,
 * waiting on the owner's review, so the inbox shot reads like a working day.
 */
import { homedir } from "node:os";

import type { BrowserContext, Page } from "playwright";

import { privateNames, readLocalConfig } from "../../../scripts/localConfig.ts";

export type Json = null | boolean | number | string | Array<Json> | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

/** Who the shots show instead of the fixture's owner, and the other accounts after it. */
export const ALIAS = { owner: "acme-dev", name: "Acme Dev", repo: "shortlinks" } as const;
const OTHER_ACCOUNTS = ["acme-work", "acme-oss", "acme-labs", "acme-play"];

export const isObject = (value: Json | undefined): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const text = (value: Json | undefined): string => (typeof value === "string" ? value : "");

/** The fixture repository from `.e2e/local.json`, the only one a shot may show, and its account. */
export const shownFixture = () => {
  const repository = readLocalConfig()?.fixtureRepo;
  if (repository === undefined)
    throw new Error(
      'Shots show only your fixture repository: write {"fixtureRepo": "<owner>/<name>"} to .e2e/local.json.',
    );
  const [owner = "", repo = ""] = repository.split("/");
  return { repository, owner, repo, account: `github.com/${owner}` };
};

const escape = (name: string) => name.replaceAll(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** Whole names only, any case: `owner/prkit` must not match inside `owner/prkit-fixtures`. */
const wholeNames = (names: Iterable<string>) => {
  const sorted = [...names].filter((name) => name.length > 0).sort((a, b) => b.length - a.length);
  return sorted.length === 0
    ? null
    : new RegExp(`(?<![\\w.-])(?:${sorted.map(escape).join("|")})(?![\\w.-])`, "gi");
};

/** A five by five mirrored pattern drawn from the name, so every placeholder has its own face. */
const avatarFor = (name: string) => {
  let hash = 2166136261;
  for (const char of name) hash = Math.imul(hash ^ (char.codePointAt(0) ?? 0), 16777619) >>> 0;
  const hue = (hash >>> 16) % 360;
  const cells = Array.from({ length: 15 }, (_, bit) => bit).flatMap((bit) => {
    if (((hash >>> bit) & 1) === 0) return [];
    const x = bit % 3;
    const y = Math.floor(bit / 3);
    return x === 2
      ? [[2, y]]
      : [
          [x, y],
          [4 - x, y],
        ];
  });
  const rects = cells.map(
    ([x = 0, y = 0]) => `<rect x="${x + 1}" y="${y + 1}" width="1" height="1"/>`,
  );
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 7 7" shape-rendering="crispEdges"><rect width="7" height="7" fill="hsl(${hue} 45% 92%)"/><g fill="hsl(${hue} 55% 48%)">${rects.join("")}</g></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
};

/** A fixture pull request the page sees as `author`'s, asking for the owner's review. */
export type ReviewRequest = { number: number; author: string };

export function createClientSafeSocket(
  shown: ReturnType<typeof shownFixture>,
  reviewRequests: ReadonlyArray<ReviewRequest> = [],
) {
  const home = homedir();
  const dropped = new Set<string>();
  /** Real name, lower case, to the placeholder the page sees. */
  const aliases = new Map<string, string>([
    [shown.owner.toLowerCase(), ALIAS.owner],
    [shown.repo.toLowerCase(), ALIAS.repo],
  ]);
  const realNames = new Map<string, string>([
    [ALIAS.owner, shown.owner],
    [ALIAS.repo, shown.repo],
  ]);
  let otherAccounts = 0;
  let otherPeople = 0;

  const aliasLogin = (login: string, isAccount: boolean) => {
    const known = aliases.get(login.toLowerCase());
    if (known !== undefined) return known;
    const alias = isAccount
      ? (OTHER_ACCOUNTS[otherAccounts++] ?? `acme-${otherAccounts}`)
      : `teammate-${++otherPeople}`;
    aliases.set(login.toLowerCase(), alias);
    realNames.set(alias, login);
    return alias;
  };

  const displayName = (alias: string) =>
    alias === ALIAS.owner
      ? ALIAS.name
      : alias.replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());

  /** Learns every login (and its name) in a frame before any text in it is rewritten. */
  const learn = (value: Json): void => {
    if (Array.isArray(value)) {
      for (const inner of value) learn(inner);
      return;
    }
    if (!isObject(value)) return;
    const login = text(value.login);
    if (login.length > 0) {
      const alias = aliasLogin(login, false);
      const name = text(value.name);
      if (name.length > 0 && !aliases.has(name.toLowerCase())) {
        aliases.set(name.toLowerCase(), displayName(alias));
      }
    }
    for (const inner of Object.values(value)) learn(inner);
  };

  /**
   * Whether one row of any list may reach the page, judged by what the row is rather than which
   * answer it came in, so a reshaped answer can't carry another repository past the filter.
   */
  const keepRow = (row: Json): boolean => {
    if (!isObject(row)) return true;
    if (isObject(row.ref)) {
      const owner = text(row.ref.owner);
      const repo = text(row.ref.repo);
      const account = row.accountId === undefined || row.accountId === shown.account;
      // Journeys open and close throwaway pull requests on `e2e/` branches all the time.
      if (account && owner === shown.owner && repo === shown.repo) {
        return !text(row.headBranch).startsWith("e2e/");
      }
      if (owner !== shown.owner) dropped.add(owner);
      dropped.add(`${owner}/${repo}`);
      return false;
    }
    if (Array.isArray(row.accountIds)) {
      const keep = row.owner === shown.owner && row.name === shown.repo;
      if (!keep) dropped.add(`${text(row.owner)}/${text(row.name)}`);
      return keep;
    }
    return row.accountId === undefined || row.accountId === shown.account;
  };

  const filter = (value: Json, key = ""): Json => {
    if (Array.isArray(value)) {
      // "Showing 100 of N" counts pull requests the shots never show.
      if (key === "truncated" || key === "addedConfigDirs" || key === "configDirProblems")
        return [];
      return value.filter(keepRow).map((inner) => filter(inner));
    }
    if (!isObject(value)) return value;
    // Every account stays, under a placeholder, so the inbox still reads as many accounts.
    if (typeof value.configDir === "string" && typeof value.login === "string") {
      const alias = aliasLogin(value.login, true);
      return {
        ...value,
        status: { _tag: "ready" },
        configDir: alias === ALIAS.owner ? "~/.config/gh" : `~/.config/gh-${alias}`,
      };
    }
    return Object.fromEntries(
      Object.entries(value).map(([name, inner]) => [name, filter(inner, name)]),
    );
  };

  /** Every string with the home path and each real name replaced, every avatar redrawn. */
  const disguise = (value: Json, names: RegExp | null): Json => {
    if (typeof value === "string") {
      const local = value.replaceAll(home, "~");
      return names === null
        ? local
        : local.replace(names, (name) => aliases.get(name.toLowerCase()) ?? name);
    }
    if (Array.isArray(value)) return value.map((inner) => disguise(inner, names));
    if (!isObject(value)) return value;
    const login = text(value.login);
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [
        key,
        key === "avatarUrl" && inner !== null
          ? avatarFor(aliases.get(login.toLowerCase()) ?? login)
          : disguise(inner, names),
      ]),
    );
  };

  /** Runs after `disguise`, so the inbox entries it changes already show the placeholders. */
  const askForReview = (value: Json): Json => {
    if (Array.isArray(value)) return value.map(askForReview);
    if (!isObject(value)) return value;
    const ref = Array.isArray(value.reasons) && isObject(value.ref) ? value.ref : undefined;
    const request =
      ref?.owner === ALIAS.owner && ref.repo === ALIAS.repo
        ? reviewRequests.find(({ number }) => number === ref.number)
        : undefined;
    if (request !== undefined) {
      return {
        ...value,
        reasons: ["review-requested"],
        author: { login: request.author, avatarUrl: avatarFor(request.author) },
      };
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [key, askForReview(inner)]),
    );
  };

  const fromServer = (frame: string): string => {
    const filtered = filter(JSON.parse(frame));
    learn(filtered);
    return JSON.stringify(askForReview(disguise(filtered, wholeNames(aliases.keys()))));
  };

  const fromPage = (frame: string): string => {
    const names = wholeNames(realNames.keys());
    return names === null
      ? frame
      : frame.replace(names, (name) => realNames.get(name.toLowerCase()) ?? name);
  };

  return {
    install: async (context: BrowserContext) => {
      // Only the app's own origin answers; nothing reaches GitHub's avatars or any other host.
      await context.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => route.abort());
      await context.routeWebSocket(/\/ws(\?|$)/, (ws) => {
        const server = ws.connectToServer();
        ws.onMessage((message) =>
          server.send(typeof message === "string" ? fromPage(message) : message),
        );
        server.onMessage((message) =>
          ws.send(typeof message === "string" ? fromServer(message) : message),
        );
      });
    },

    /**
     * Throws when a dropped or replaced name, a `.private-names` entry or the home path is in
     * the page, shadow roots included. Returns how many names it looked for.
     */
    assertClean: async (page: Page, shot: string) => {
      const markup = await page.evaluate(() => {
        const parts = [document.documentElement.outerHTML];
        for (const element of document.querySelectorAll("*")) {
          if (element.shadowRoot) parts.push(element.shadowRoot.innerHTML);
        }
        return parts.join("\n");
      });
      const names = new Set(
        [...dropped, ...aliases.keys(), ...privateNames().map(({ name }) => name), home]
          .map((name) => name.trim().toLowerCase())
          .filter((name) => name.length > 0),
      );
      const lower = markup.toLowerCase();
      // The context shows where a name surfaced without printing the name itself.
      const leaks = [...names].flatMap((name) => {
        const at = lower.search(new RegExp(`(?<![\\w.-])${escape(name)}(?![\\w.-])`));
        return at < 0 ? [] : [`…${lower.slice(Math.max(0, at - 120), at)}<hidden name>…`];
      });
      if (leaks.length > 0) {
        throw new Error(`${shot}: hidden names reached the page; not saved.\n${leaks.join("\n")}`);
      }
      return names.size;
    },
  };
}
