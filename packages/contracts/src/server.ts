import * as Schema from "effect/Schema";

import { ThemePreference } from "./appearance.ts";

/**
 * The single JSON line the server prints on stdout once it serves, has written the discovery
 * file and has tried to write the launchers that outside agents and the CLI read. By then,
 * `/health` answers 200.
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

/**
 * Printed on stdout instead of the ready line when another server already holds the home,
 * just before the server exits. Electron shows it; nothing else is started.
 */
export const ServerHomeInUseLine = Schema.Struct({
  type: Schema.Literal("home-in-use"),
  home: Schema.String,
});

export const ServerHomeInUseLineJson = Schema.fromJsonString(ServerHomeInUseLine);
