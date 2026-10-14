import * as Schema from "effect/Schema";

/** The release track the app updates from. Stable reads latest-mac.yml, Nightly nightly-mac.yml. */
export const UpdateChannel = Schema.Literals(["stable", "nightly"]);
export type UpdateChannel = typeof UpdateChannel.Type;

/** One line of a release's notes, with its pull request when the notes link one. */
export const ReleaseNoteItem = Schema.Struct({
  text: Schema.String,
  prUrl: Schema.optionalKey(Schema.String),
});
export type ReleaseNoteItem = typeof ReleaseNoteItem.Type;

/** A heading of the release body (Features, Fixes, Performance) and its lines. */
export const ReleaseNoteGroup = Schema.Struct({
  title: Schema.String,
  items: Schema.Array(ReleaseNoteItem),
});
export type ReleaseNoteGroup = typeof ReleaseNoteGroup.Type;

/**
 * One version's notes. `summary` holds a body with no list, such as "No user-facing changes
 * in this release."; `omittedItems` counts the lines cut to keep the notes short.
 */
export const ReleaseNotesVersion = Schema.Struct({
  version: Schema.String,
  groups: Schema.Array(ReleaseNoteGroup),
  summary: Schema.NullOr(Schema.String),
  omittedItems: Schema.Number,
});
export type ReleaseNotesVersion = typeof ReleaseNotesVersion.Type;

/** Newest first; `omittedVersions` counts the older versions cut from the list. */
export const ReleaseNotes = Schema.Struct({
  versions: Schema.Array(ReleaseNotesVersion),
  omittedVersions: Schema.Number,
});
export type ReleaseNotes = typeof ReleaseNotes.Type;

export const DesktopUpdateStatus = Schema.Literals([
  "disabled",
  "idle",
  "checking",
  "up-to-date",
  "available",
  "downloading",
  "downloaded",
  "error",
]);
export type DesktopUpdateStatus = typeof DesktopUpdateStatus.Type;

/** What failed last: a check leaves `error`, a download `available`, an install `downloaded`. */
export const DesktopUpdateErrorContext = Schema.Literals(["check", "download", "install"]);
export type DesktopUpdateErrorContext = typeof DesktopUpdateErrorContext.Type;

/** The update this launch came from, until the page has shown its "Updated to" toast. */
export const WhatsNew = Schema.Struct({ version: Schema.String, releaseNotes: ReleaseNotes });
export type WhatsNew = typeof WhatsNew.Type;

export const DesktopUpdateState = Schema.Struct({
  status: DesktopUpdateStatus,
  /** Why updates are off; set only with status `disabled`. */
  disabledReason: Schema.NullOr(Schema.String),
  channel: UpdateChannel,
  currentVersion: Schema.String,
  availableVersion: Schema.NullOr(Schema.String),
  downloadPercent: Schema.NullOr(Schema.Number),
  releaseNotes: ReleaseNotes,
  errorMessage: Schema.NullOr(Schema.String),
  errorContext: Schema.NullOr(DesktopUpdateErrorContext),
  /** ISO time of the last check that finished. */
  lastCheckedAt: Schema.NullOr(Schema.String),
  /** Every release of the feed, built from its owner and repository; null when unknown. */
  releasesUrl: Schema.NullOr(Schema.String),
  whatsNew: Schema.NullOr(WhatsNew),
});
export type DesktopUpdateState = typeof DesktopUpdateState.Type;

/** The answer to check, download, install and set-channel: whether it started, and the state after. */
export const DesktopUpdateActionResult = Schema.Struct({
  accepted: Schema.Boolean,
  state: DesktopUpdateState,
});
export type DesktopUpdateActionResult = typeof DesktopUpdateActionResult.Type;

export const NIGHTLY_VERSION = /^\d+\.\d+\.\d+-nightly\.\d{8}\.\d+$/;

/** The track a version belongs to: a `-nightly.<yyyymmdd>.<n>` version is Nightly. */
export const channelOfVersion = (version: string): UpdateChannel =>
  NIGHTLY_VERSION.test(version) ? "nightly" : "stable";
