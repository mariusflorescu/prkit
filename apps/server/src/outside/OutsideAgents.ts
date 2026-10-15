import {
  cleanClientName,
  OUTSIDE_AGENTS_DEFAULTS,
  OUTSIDE_DISCOVERY_FILE,
  OUTSIDE_LAUNCHER,
  type OutsideAgentsSettings,
  OutsideAgentsError,
  OutsideAgentsSettings as SettingsSchema,
  type OutsideClient,
  type OutsideDiscovery,
  OutsideDiscoveryJson,
} from "@prkit/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import { Base64Url, Hex } from "effect/encoding";

import * as ServerConfig from "../config.ts";
import { launcherScript } from "./launcher.ts";

const SETTINGS_KEY = "outsideAgents.settings";
const SettingsJson = Schema.fromJsonString(SettingsSchema);
const SettingRows = Schema.Array(Schema.Struct({ value: Schema.String }));
/** Clients unseen this long drop off the list; a client sends something at least on every call. */
const CLIENT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The switch, the access level, the endpoint's token and the discovery file
 * (docs/features/outside-agents.md). The token is new on every launch, every switch on,
 * every level change and every Reset access; prkit keeps only its SHA-256, and the
 * discovery file is the one place it is written.
 */
export class OutsideAgents extends Context.Service<OutsideAgents, Effect.Success<typeof make>>()(
  "@prkit/server/outside/OutsideAgents",
) {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig.ServerConfig;
  const gate = yield* Semaphore.make(1);

  const discoveryPath = path.join(config.home, OUTSIDE_DISCOVERY_FILE);
  const launcher = path.join(config.home, OUTSIDE_LAUNCHER);
  const digest = (token: string) =>
    crypto.digest("SHA-256", new TextEncoder().encode(token)).pipe(Effect.map(Hex.encode));

  const failure = (message: string) => () => Effect.fail(new OutsideAgentsError({ message }));
  const stored = yield* sql`SELECT value FROM settings WHERE key = ${SETTINGS_KEY}`.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(SettingRows)),
    Effect.flatMap((rows) =>
      rows[0] === undefined
        ? Effect.succeed(OUTSIDE_AGENTS_DEFAULTS)
        : Schema.decodeEffect(SettingsJson)(rows[0].value),
    ),
    // Damaged settings start switched off; the owner turns it on again.
    Effect.orElseSucceed(() => OUTSIDE_AGENTS_DEFAULTS),
  );
  let settings: OutsideAgentsSettings = stored;
  let tokenHash: string | null = null;
  /** The bound port, once the server listens; nothing is written before. */
  let port: number | null = null;
  const clients = new Map<string, OutsideClient>();

  const writeDiscovery = (file: OutsideDiscovery) =>
    Effect.gen(function* () {
      const text = yield* Schema.encodeEffect(OutsideDiscoveryJson)(file);
      const temporary = `${discoveryPath}.${process.pid}.tmp`;
      yield* fs.writeFileString(temporary, text, { mode: 0o600 });
      yield* fs.chmod(temporary, 0o600);
      yield* fs.rename(temporary, discoveryPath);
    });

  /** Writes the file for the current settings with a new token, or with none while off. */
  const publish = Effect.gen(function* () {
    if (port === null) return;
    if (!settings.enabled) {
      tokenHash = null;
      return yield* writeDiscovery({ _tag: "off", pid: process.pid, version: config.version });
    }
    const token = Base64Url.encode(yield* crypto.randomBytes(32));
    tokenHash = yield* digest(token);
    yield* writeDiscovery({
      _tag: "on",
      port,
      token,
      pid: process.pid,
      version: config.version,
      access: settings.access,
    });
  });

  const state = Effect.gen(function* () {
    const now = yield* DateTime.now;
    const cutoff = DateTime.toEpochMillis(now) - CLIENT_TTL_MS;
    for (const [id, client] of clients)
      if (Date.parse(client.lastSeenAt) < cutoff) clients.delete(id);
    return {
      ...settings,
      clients: [...clients.values()].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt)),
      launcher,
    };
  });

  const get = () => gate.withPermits(1)(state);

  const update = (next: OutsideAgentsSettings) =>
    gate.withPermits(1)(
      Effect.gen(function* () {
        const text = yield* Schema.encodeEffect(SettingsJson)(next);
        yield* sql`INSERT INTO settings (key, value) VALUES (${SETTINGS_KEY}, ${text})
          ON CONFLICT (key) DO UPDATE SET value = excluded.value`;
        const changed = next.enabled !== settings.enabled || next.access !== settings.access;
        settings = next;
        if (changed) yield* publish;
        return yield* state;
      }).pipe(
        Effect.catchTags({
          SqlError: failure("prkit couldn't save this setting. Try again."),
          SchemaError: failure("prkit couldn't save this setting. Try again."),
          PlatformError: failure(
            "prkit saved the setting but couldn't write its file for outside agents. Try again.",
          ),
        }),
      ),
    );

  /** A new token: every client must read the new file, and the list starts empty. */
  const reset = () =>
    gate.withPermits(1)(
      Effect.gen(function* () {
        clients.clear();
        yield* publish;
        yield* Effect.logInfo("Outside agents' access reset");
        return yield* state;
      }).pipe(
        Effect.catchTags({
          PlatformError: failure(
            "prkit couldn't write the new access for outside agents. Try again.",
          ),
          SchemaError: failure(
            "prkit couldn't write the new access for outside agents. Try again.",
          ),
        }),
      ),
    );

  /** Whether a bearer token is the current one. Off, nothing is. */
  const accepts = (token: string) =>
    tokenHash === null || token === ""
      ? Effect.succeed(false)
      : digest(token).pipe(
          Effect.map((hash) => hash === tokenHash),
          Effect.orElseSucceed(() => false),
        );

  /** Records a request from a client, by the name it gave in `initialize`. */
  const seen = (bridgeId: string, name: string) =>
    Effect.gen(function* () {
      const id = bridgeId.slice(0, 64);
      if (id === "") return;
      const lastSeenAt = DateTime.formatIso(yield* DateTime.now);
      clients.set(id, { id, name: cleanClientName(name), lastSeenAt });
    });

  /**
   * Starts once the server listens: the launcher for this home, and the discovery file.
   * The file goes when the server stops; a crash leaves it with a dead pid, which a client
   * reads as prkit not being open.
   */
  const start = (boundPort: number) =>
    Effect.acquireRelease(
      gate.withPermits(1)(
        Effect.gen(function* () {
          port = boundPort;
          yield* fs.makeDirectory(path.dirname(launcher), { recursive: true });
          yield* fs.writeFileString(launcher, launcherScript(config.home), { mode: 0o700 });
          yield* fs.chmod(launcher, 0o700);
          yield* publish;
        }),
      ),
      () =>
        fs.remove(discoveryPath, { force: true }).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              tokenHash = null;
            }),
          ),
          Effect.ignore,
        ),
    );

  return {
    get,
    update,
    reset,
    accepts,
    seen,
    start,
    /** The settings as they are this moment, for checks that can't wait. */
    current: () => settings,
    discoveryPath,
    launcher,
    port: () => Option.fromNullishOr(port),
  };
});

export const layer = Layer.effect(OutsideAgents, make);
