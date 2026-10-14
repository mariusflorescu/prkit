import * as Schema from "effect/Schema";

import { ThemePreference } from "./appearance.ts";

/**
 * The single JSON line the server prints on stdout once it listens.
 * apps/desktop and scripts/dev-runner.ts parse it; all logs go to stderr.
 * `theme` is the stored appearance, so Electron can set it before the first window exists.
 */
export const ServerReadyLine = Schema.Struct({
  type: Schema.Literal("ready"),
  port: Schema.Int,
  url: Schema.String,
  theme: ThemePreference,
});
export type ServerReadyLine = typeof ServerReadyLine.Type;

export const ServerReadyLineJson = Schema.fromJsonString(ServerReadyLine);
