export type UpdaterOperation = "check" | "download" | "install";

const NO_RELEASE_CODES = new Set([
  "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND",
  "ERR_UPDATER_LATEST_VERSION_NOT_FOUND",
  "ERR_UPDATER_NO_PUBLISHED_VERSIONS",
]);
const OFFLINE = /net::ERR_|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN/;
/** Squirrel.Mac refuses an app whose signature doesn't match the running one. */
const SIGNATURE = /code signature|did not pass validation|code requirement/i;
/** Any URL, and any absolute path, which on macOS names the user's home. */
const LOCATION = /\b[a-z][a-z0-9+.-]*:\/\/\S+|(?:^|\s)\/\S+/gi;
const MAX_DETAIL = 160;

const VERBS = {
  check: "check for updates",
  download: "download the update",
  install: "install the update",
} as const;

const shorten = (text: string) => {
  if (text.length <= MAX_DETAIL) return text;
  const cut = text.slice(0, MAX_DETAIL);
  const lastSpace = cut.lastIndexOf(" ");
  return `${lastSpace > 0 ? cut.slice(0, lastSpace) : cut}…`;
};

/**
 * A message a person can act on. electron-updater's own errors carry response headers and
 * whole feeds after the first line, and Squirrel's name files in the cache, so only a short
 * first line with no URL or path ever leaves this function.
 */
export const describeUpdaterError = (
  operation: UpdaterOperation,
  error: { readonly message?: string; readonly code?: string },
) => {
  const message = error.message ?? "";
  if (error.code !== undefined && NO_RELEASE_CODES.has(error.code))
    return "There's no release on this track yet.";
  if (OFFLINE.test(message) || (error.code !== undefined && OFFLINE.test(error.code)))
    return `prkit couldn't reach the update server to ${VERBS[operation]}. Check your connection and try again.`;
  if (SIGNATURE.test(message))
    return "macOS couldn't verify the downloaded update, so prkit didn't install it. Download the newest version from the releases page instead.";
  const firstLine = (message.split(/\r?\n/, 1)[0] ?? "")
    .replace(LOCATION, " …")
    .replace(/\s+/g, " ")
    .trim();
  return firstLine === ""
    ? `prkit couldn't ${VERBS[operation]}.`
    : `prkit couldn't ${VERBS[operation]}. ${shorten(firstLine)}`;
};
