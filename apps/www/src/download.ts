/**
 * Turns the download surfaces on once a stable release exists. The page ships saying "Coming
 * soon"; this asks GitHub for the latest release and, only when it holds an Apple Silicon disk
 * image, fills in the links and sets `data-release="ready"` on the root, which cross-fades every
 * surface (global.css). Any failure leaves the page as it shipped, without a word.
 */
import {
  type Download,
  type Json,
  latestReleaseApi,
  pickDownload,
  readDownload,
  releasesPage,
} from "./release.ts";

const CACHE_KEY = "prkit-release";
// Unauthenticated GitHub calls allow 60 an hour per address; a visit reads it once.
const CACHE_MS = 10 * 60_000;
const TIMEOUT_MS = 5_000;

const parse = (text: string): Json | undefined => {
  try {
    const value: Json = JSON.parse(text);
    return value;
  } catch {
    return undefined;
  }
};

/** A cached answer: a download, null for "no release yet", or undefined when nothing fresh. */
const cached = (): Download | null | undefined => {
  try {
    const entry = parse(sessionStorage.getItem(CACHE_KEY) ?? "");
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined;
    if (typeof entry.at !== "number" || Date.now() - entry.at > CACHE_MS) return undefined;
    return entry.download === null ? null : (readDownload(entry.download) ?? undefined);
  } catch {
    return undefined;
  }
};

const remember = (download: Download | null) => {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), download }));
  } catch {}
};

const lookUp = async (repository: string): Promise<Download | null> => {
  const known = cached();
  if (known !== undefined) return known;
  try {
    const response = await fetch(latestReleaseApi(repository), {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status === 404) {
      remember(null);
      return null;
    }
    if (!response.ok) return null;
    const release = parse(await response.text());
    const download = release === undefined ? null : pickDownload(release, releasesPage(repository));
    if (download) remember(download);
    return download;
  } catch {
    return null;
  }
};

const show = (download: Download) => {
  const name = `Download prkit ${download.version} for macOS, Apple Silicon`;
  for (const link of document.querySelectorAll<HTMLAnchorElement>("[data-release-link]")) {
    const kind = link.dataset.releaseLink;
    link.href =
      kind === "notes"
        ? download.notesUrl
        : kind === "all"
          ? download.releasesUrl
          : download.dmgUrl;
    if (kind === "dmg") link.setAttribute("aria-label", name);
  }
  for (const node of document.querySelectorAll<HTMLElement>("[data-release-labelledby]")) {
    node.setAttribute("aria-labelledby", node.dataset.releaseLabelledby ?? "");
  }
  for (const node of document.querySelectorAll("[data-release-version]")) {
    node.textContent = download.version;
  }
  document.documentElement.dataset.release = "ready";
};

const repository = document.querySelector<HTMLElement>("[data-release-repo]")?.dataset.releaseRepo;
if (repository) {
  void lookUp(repository).then((download) => {
    if (download) show(download);
  });
}
