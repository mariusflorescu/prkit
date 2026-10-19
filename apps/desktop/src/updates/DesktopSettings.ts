import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";

import { ReleaseNotes, UpdateChannel, type WhatsNew } from "@prkit/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** The desktop shell's own settings, in userData. The server's home never holds them. */
const SETTINGS_FILE = "desktop-settings.json";
/** The notes of the last downloaded update, shown once after it installs. */
const NOTES_FILE = "update-notes.json";

const SettingsJson = Schema.fromJsonString(
  Schema.Struct({ updateChannel: Schema.optionalKey(UpdateChannel) }),
);
const NotesJson = Schema.fromJsonString(
  Schema.Struct({ version: Schema.String, releaseNotes: ReleaseNotes, shown: Schema.Boolean }),
);
export type StoredNotes = typeof NotesJson.Type;

export class SettingsWriteFailed extends Schema.TaggedError<SettingsWriteFailed>()(
  "SettingsWriteFailed",
  { message: Schema.String },
) {}

export class DesktopSettings extends Context.Service<
  DesktopSettings,
  {
    /** The track the user picked; none until they pick one. */
    readonly updateChannel: Effect.Effect<Option.Option<UpdateChannel>>;
    readonly setUpdateChannel: (channel: UpdateChannel) => Effect.Effect<void, SettingsWriteFailed>;
    readonly downloadedNotes: Effect.Effect<Option.Option<StoredNotes>>;
    readonly saveDownloadedNotes: (notes: WhatsNew) => Effect.Effect<void>;
    readonly markNotesShown: (version: string) => Effect.Effect<void>;
  }
>()("@prkit/desktop/updates/DesktopSettings") {}

export const make = (userDataDir: string) => {
  const read = <A>(file: string, decode: (text: string) => Option.Option<A>) =>
    Effect.tryPromise(() => NodeFS.readFile(NodePath.join(userDataDir, file), "utf8")).pipe(
      Effect.map(decode),
      Effect.orElseSucceed(() => Option.none<A>()),
    );
  // Written beside the file, then renamed over it, so a crash never leaves half a file.
  const write = (file: string, text: string) =>
    Effect.tryPromise(async () => {
      const target = NodePath.join(userDataDir, file);
      await NodeFS.mkdir(userDataDir, { recursive: true });
      await NodeFS.writeFile(`${target}.tmp`, text);
      await NodeFS.rename(`${target}.tmp`, target);
    });
  const decodeSettings = Schema.decodeUnknownOption(SettingsJson);
  const decodeNotes = Schema.decodeUnknownOption(NotesJson);
  const encodeSettings = Schema.encodeSync(SettingsJson);
  const encodeNotes = Schema.encodeSync(NotesJson);
  const downloadedNotes = read(NOTES_FILE, decodeNotes);
  const saveNotes = (notes: StoredNotes) =>
    write(NOTES_FILE, encodeNotes(notes)).pipe(
      Effect.catch(() => Effect.logWarning("prkit couldn't save the update's release notes.")),
    );

  return DesktopSettings.of({
    updateChannel: read(SETTINGS_FILE, decodeSettings).pipe(
      Effect.map(Option.flatMap((settings) => Option.fromNullishOr(settings.updateChannel))),
    ),
    setUpdateChannel: (channel) =>
      read(SETTINGS_FILE, decodeSettings).pipe(
        Effect.flatMap((settings) =>
          write(
            SETTINGS_FILE,
            encodeSettings({ ...Option.getOrElse(settings, () => ({})), updateChannel: channel }),
          ),
        ),
        Effect.mapError(
          () =>
            new SettingsWriteFailed({
              message: "prkit couldn't save the update track.",
            }),
        ),
      ),
    downloadedNotes,
    saveDownloadedNotes: (notes) => saveNotes({ ...notes, shown: false }),
    markNotesShown: (version) =>
      downloadedNotes.pipe(
        Effect.flatMap((stored) =>
          Option.isSome(stored) && stored.value.version === version && !stored.value.shown
            ? saveNotes({ ...stored.value, shown: true })
            : Effect.void,
        ),
      ),
  });
};

export const layer = (userDataDir: string) => Layer.succeed(DesktopSettings, make(userDataDir));
