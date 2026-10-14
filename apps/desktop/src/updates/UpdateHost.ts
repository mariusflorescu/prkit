import type { DesktopUpdateState } from "@prkit/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export class ServerRestartFailed extends Schema.TaggedError<ServerRestartFailed>()(
  "ServerRestartFailed",
  { message: Schema.String },
) {}

/** What the updater needs from the Electron shell: the app's facts, the windows, and the server child. */
export class UpdateHost extends Context.Service<
  UpdateHost,
  {
    readonly appVersion: string;
    readonly isPackaged: boolean;
    /** PRKIT_DISABLE_AUTO_UPDATE is set. */
    readonly disabledByEnv: boolean;
    /** The packaged app's Resources/app-update.yml; none when the build has no feed. */
    readonly readUpdateConfig: Effect.Effect<Option.Option<string>>;
    /** Sends the state to every window. */
    readonly publish: (state: DesktopUpdateState) => Effect.Effect<void>;
    /** SIGTERM, a 5 second grace, then waits for the server child to exit. */
    readonly stopServer: Effect.Effect<void>;
    /** Starts the server again after an install that didn't happen. */
    readonly restartServer: Effect.Effect<void, ServerRestartFailed>;
  }
>()("@prkit/desktop/updates/UpdateHost") {}

/** The feed in app-update.yml, and where its releases are listed for people. */
export interface UpdateFeed {
  readonly provider: string;
  readonly releasesUrl: string | null;
}

const FIELD = /^(\w+):\s*(.*?)\s*$/;

/**
 * electron-builder writes app-update.yml as flat `key: value` lines. The releases link is built
 * from the feed itself, so no repository is ever written into the app's code.
 */
export const parseUpdateFeed = (yml: string): Option.Option<UpdateFeed> => {
  const fields = new Map<string, string>();
  for (const line of yml.split("\n")) {
    const match = FIELD.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined)
      fields.set(match[1], match[2].replace(/^["']|["']$/g, ""));
  }
  const provider = fields.get("provider");
  if (provider === undefined || provider === "") return Option.none();
  const owner = fields.get("owner");
  const repo = fields.get("repo");
  const url = fields.get("url");
  const releasesUrl =
    provider === "github" && owner !== undefined && repo !== undefined
      ? `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases`
      : provider === "generic" && url !== undefined && /^https?:\/\//.test(url)
        ? url
        : null;
  return Option.some({ provider, releasesUrl });
};
