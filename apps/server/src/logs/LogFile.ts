import { LogError, type RecentLog } from "@prkit/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import { redactSecrets } from "./redact.ts";

/** A write that would take `server.log` past this moves it to `server.log.1` first. */
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const RECENT_BYTES = 256 * 1024;
const FLUSH_WINDOW = "250 millis";

const isMissing = (error: PlatformError) => error.reason._tag === "NotFound";

/**
 * The server's log kept in `<home>/logs/server.log`, next to stderr, which a Finder launch
 * throws away. It rotates through `server.log.1` and `server.log.2`, holds no secret
 * (`redact.ts`), and `recent` reads its newest lines for Settings > About.
 */
export class LogFile extends Context.Service<LogFile, Effect.Success<typeof make>>()(
  "@prkit/server/logs/LogFile",
) {}

export const make = Effect.gen(function* () {
  const { home } = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // A flush and a read never overlap, so a read never sees the files halfway through a rotation.
  const gate = yield* Semaphore.make(1);

  const directory = path.join(home, "logs");
  const current = path.join(directory, "server.log");
  const first = `${current}.1`;
  const second = `${current}.2`;

  // A folder or file an earlier run or a person left keeps the modes prkit gives its own.
  yield* Effect.forEach(
    [
      [directory, 0o700],
      [current, 0o600],
      [first, 0o600],
      [second, 0o600],
    ] as const,
    ([target, mode]) => fs.chmod(target, mode).pipe(Effect.catchIf(isMissing, () => Effect.void)),
    { discard: true },
  ).pipe(Effect.catchTag("PlatformError", () => Effect.void));

  const sizeOf = (file: string) =>
    fs.stat(file).pipe(
      Effect.map((info) => Number(info.size)),
      Effect.catchIf(isMissing, () => Effect.succeed(0)),
    );

  /**
   * Each step looks at the files as they are, so a rotation that stopped anywhere finishes on
   * the next write: with `.1` gone the older files already moved up, and `.2` is kept.
   */
  const rotate = Effect.gen(function* () {
    if (yield* fs.exists(first)) {
      yield* fs.remove(second, { force: true });
      yield* fs.rename(first, second);
    }
    yield* fs.rename(current, first);
  });

  const append = Effect.fnUntraced(function* (bytes: Uint8Array) {
    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
    const size = yield* sizeOf(current);
    if (size > 0 && size + bytes.length > MAX_FILE_BYTES) yield* rotate;
    yield* fs.writeFile(current, bytes, { flag: "a", mode: 0o600 });
  });

  const flush = (lines: ReadonlyArray<string>) =>
    gate
      .withPermits(1)(append(new TextEncoder().encode(redactSecrets(`${lines.join("\n")}\n`))))
      // The log is a convenience. A full disk or a folder the user removed must not stop the
      // server, and logging the failure would only feed the next flush.
      .pipe(Effect.catchTag("PlatformError", () => Effect.void));

  const logger = yield* Logger.batched(Logger.formatLogFmt, { window: FLUSH_WINDOW, flush });

  /** The last `limit` bytes of `file` at most, and whether that is all of it. */
  const tail = (file: string, limit: number) =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* fs.open(file, { flag: "r" });
        const size = Number((yield* handle.stat).size);
        const start = Math.max(0, size - limit);
        yield* handle.seek(BigInt(start), "start");
        const bytes = new Uint8Array(size - start);
        let filled = 0;
        while (filled < bytes.length) {
          const read = yield* handle.read(bytes.subarray(filled));
          if (read === 0) break;
          filled += read;
        }
        return { bytes: bytes.subarray(0, filled), whole: start === 0 };
      }),
    ).pipe(
      Effect.catchIf(isMissing, () => Effect.succeed({ bytes: new Uint8Array(), whole: true })),
    );

  const recent: Effect.Effect<RecentLog, LogError> = gate
    .withPermits(1)(
      Effect.gen(function* () {
        const after = yield* tail(current, RECENT_BYTES);
        const before = after.whole
          ? yield* tail(first, RECENT_BYTES - after.bytes.length)
          : { bytes: new Uint8Array(), whole: false };
        const both = new Uint8Array(before.bytes.length + after.bytes.length);
        both.set(before.bytes);
        both.set(after.bytes, before.bytes.length);
        const window = new TextDecoder().decode(both);
        if (before.whole && !(yield* fs.exists(second))) return { text: window, truncated: false };
        // The window starts anywhere in a line, so it begins after its first newline.
        const newline = window.indexOf("\n");
        return { text: newline === -1 ? "" : window.slice(newline + 1), truncated: true };
      }),
    )
    .pipe(
      Effect.catchTag("PlatformError", () =>
        Effect.fail(new LogError({ message: "prkit couldn't read its server log." })),
      ),
    );

  return { logger, recent };
});

export const layer = Layer.effect(LogFile, make);
