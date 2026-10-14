/**
 * Which download the site offers, read from GitHub's latest release. Only a published stable
 * release with an Apple Silicon disk image counts; anything else leaves the page on "Coming soon".
 */

export type Json = null | boolean | number | string | Array<Json> | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

export interface Download {
  /** `0.1.0`, without the tag's `v`. */
  version: string;
  dmgUrl: string;
  notesUrl: string;
  releasesUrl: string;
}

const isObject = (value: Json | undefined): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const httpsUrl = (value: Json | undefined): string | null => {
  if (typeof value !== "string") return null;
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
};

/** `owner/repo` from a repository URL on github.com, or null when it names no repository. */
export const repositoryOf = (githubUrl: string): string | null => {
  try {
    const url = new URL(githubUrl);
    if (url.hostname !== "github.com") return null;
    const match = /^\/([\w-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.pathname);
    return match ? `${match[1]}/${match[2]}` : null;
  } catch {
    return null;
  }
};

export const latestReleaseApi = (repository: string) =>
  `https://api.github.com/repos/${repository}/releases/latest`;

export const releasesPage = (repository: string) => `https://github.com/${repository}/releases`;

/** The disk image of a stable release in GitHub's `releases/latest` answer, or null. */
export const pickDownload = (release: Json, releasesUrl: string): Download | null => {
  if (!isObject(release) || release.draft !== false || release.prerelease !== false) return null;
  const tag = release.tag_name;
  const version = typeof tag === "string" ? /^v(\d+\.\d+\.\d+)$/.exec(tag)?.[1] : undefined;
  const notesUrl = httpsUrl(release.html_url);
  if (version === undefined || notesUrl === null || !Array.isArray(release.assets)) return null;
  const dmg = release.assets.find(
    (asset) => isObject(asset) && asset.name === `prkit-${version}-arm64.dmg`,
  );
  const dmgUrl = isObject(dmg) ? httpsUrl(dmg.browser_download_url) : null;
  return dmgUrl === null ? null : { version, dmgUrl, notesUrl, releasesUrl };
};

/** A download read back from storage, or null when it is not one. */
export const readDownload = (value: Json | undefined): Download | null => {
  if (!isObject(value)) return null;
  const { version, dmgUrl, notesUrl, releasesUrl } = value;
  return typeof version === "string" &&
    typeof dmgUrl === "string" &&
    typeof notesUrl === "string" &&
    typeof releasesUrl === "string"
    ? { version, dmgUrl, notesUrl, releasesUrl }
    : null;
};
