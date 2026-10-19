import {
  channelOfVersion,
  type ReleaseNoteGroup,
  type ReleaseNoteItem,
  type ReleaseNotes,
  type ReleaseNotesVersion,
  type UpdateChannel,
} from "@prkit/contracts";

import { compareVersions } from "./versions.ts";

/** What electron-updater reports: one body, a body per version, or nothing. */
export type RawReleaseNotes =
  | string
  | ReadonlyArray<{ readonly version: string; readonly note?: string | null }>
  | null
  | undefined;

export const MAX_VERSIONS = 6;
export const MAX_ITEMS_PER_VERSION = 12;
export const MAX_ITEM_LENGTH = 200;

/** The group lines land in when the body has no heading above them. */
const UNTITLED_GROUP = "Changes";

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
};

const decodeEntity = (entity: string) => {
  const named = ENTITIES[entity];
  if (named !== undefined) return named;
  const codePoint = entity.startsWith("#x")
    ? Number.parseInt(entity.slice(2), 16)
    : entity.startsWith("#")
      ? Number.parseInt(entity.slice(1), 10)
      : Number.NaN;
  return Number.isInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff
    ? String.fromCodePoint(codePoint)
    : `&${entity};`;
};

const decodeEntities = (text: string) =>
  text.replace(/&([a-zA-Z]+|#\d+|#x[0-9a-fA-F]+);/g, (_, entity: string) => decodeEntity(entity));

/**
 * GitHub's feed carries the body as HTML, which always opens with a tag; the update manifest
 * carries git-cliff's markdown, where a `<tag>` is text, such as a code span's. Both become the
 * same markdown lines, and the page shows every line as text.
 */
const toMarkdownLines = (body: string) => {
  if (!/^\s*</.test(body)) return body.split("\n");
  return body
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<a\b[^>]*?\bhref\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => {
      const label = String(text).replace(/<[^>]*>/g, "");
      // Only web links survive as links; anything else keeps its words.
      return String(href).startsWith("https://") ? `[${label}](${href})` : label;
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<h[1-6]\b[^>]*>/gi, "\n### ")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/(?:p|div|li|h[1-6]|ul|ol|blockquote)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .split("\n");
};

const PULL_REQUEST_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;
const MARKDOWN_LINK = /\[([^\]]*)\]\(([^)\s]*)\)/g;

const truncate = (text: string) =>
  text.length <= MAX_ITEM_LENGTH ? text : `${text.slice(0, MAX_ITEM_LENGTH - 1).trimEnd()}…`;

/** A list line: its text, and the first pull request it links. Release-note bodies end lines with `([#12](…/pull/12))`. */
const toItem = (line: string): ReleaseNoteItem | undefined => {
  const links = [...line.matchAll(MARKDOWN_LINK)];
  const prUrl = links
    .map((link) => decodeEntities(link[2] ?? ""))
    .find((href) => PULL_REQUEST_URL.test(href));
  const text = decodeEntities(
    line
      .replace(/\s*\(\s*\[#\d+\]\([^)]*\)\s*\)\s*$/, "")
      .replace(MARKDOWN_LINK, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/`([^`]+)`/g, "$1"),
  )
    .replace(/\s+/g, " ")
    .trim();
  if (text === "") return undefined;
  return prUrl === undefined ? { text: truncate(text) } : { text: truncate(text), prUrl };
};

const isNoise = (line: string) => {
  const normalized = line
    .toLowerCase()
    .replace(/[*_`#:]/g, "")
    .trim();
  return (
    normalized === "" ||
    normalized === "what's changed" ||
    normalized.startsWith("full changelog") ||
    normalized.includes("/compare/")
  );
};

/** One body into groups. The 12-line cap counts across groups, keeping the first lines. */
export const parseReleaseBody = (version: string, body: string): ReleaseNotesVersion => {
  const groups: Array<{ title: string; items: Array<ReleaseNoteItem> }> = [];
  let summary: string | null = null;
  let kept = 0;
  let omittedItems = 0;
  for (const raw of toMarkdownLines(body)) {
    const line = raw.trim();
    if (isNoise(line)) continue;
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading !== null) {
      const title = decodeEntities(heading[1] ?? "").trim();
      if (title !== "" && !isNoise(title)) groups.push({ title, items: [] });
      continue;
    }
    const listed = /^[-*+]\s+(.*)$/.exec(line);
    if (listed === null) {
      // A body with no list, such as "No user-facing changes in this release."
      summary ??= toItem(line)?.text ?? null;
      continue;
    }
    const item = toItem(listed[1] ?? "");
    if (item === undefined) continue;
    if (kept >= MAX_ITEMS_PER_VERSION) {
      omittedItems += 1;
      continue;
    }
    let group = groups.at(-1);
    if (group === undefined) {
      group = { title: UNTITLED_GROUP, items: [] };
      groups.push(group);
    }
    group.items.push(item);
    kept += 1;
  }
  const filled: Array<ReleaseNoteGroup> = groups.filter((group) => group.items.length > 0);
  return { version, groups: filled, summary: filled.length > 0 ? null : summary, omittedItems };
};

interface UpdateSpan {
  readonly running: string;
  readonly offered: string;
  readonly channel: UpdateChannel;
}

/**
 * The notes in the shape the page shows, newest first, for the versions the update brings. The
 * manifest lists earlier releases of the track too, the running one among them.
 */
export const normalizeReleaseNotes = (raw: RawReleaseNotes, update: UpdateSpan): ReleaseNotes => {
  const entries =
    typeof raw === "string"
      ? [{ version: update.offered, note: raw }]
      : raw === null || raw === undefined
        ? []
        : raw;
  const versions = entries
    .filter(
      (entry) =>
        channelOfVersion(entry.version) === update.channel &&
        compareVersions(entry.version, update.running) > 0 &&
        compareVersions(entry.version, update.offered) <= 0,
    )
    .map((entry) => parseReleaseBody(entry.version, entry.note ?? ""))
    .filter((version) => version.groups.length > 0 || version.summary !== null);
  return {
    versions: versions.slice(0, MAX_VERSIONS),
    omittedVersions: Math.max(0, versions.length - MAX_VERSIONS),
  };
};

export const EMPTY_RELEASE_NOTES: ReleaseNotes = { versions: [], omittedVersions: 0 };
