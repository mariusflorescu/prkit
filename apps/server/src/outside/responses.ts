import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { CurrentClient } from "../mcp/outside/access.ts";
import { fail } from "./errors.ts";
import type { ResponseFragment, ResponseInput } from "./responseSchemas.ts";

/** Includes MCP's duplicated text/structured content, escaping and envelope headroom. */
export const RESPONSE_BYTES = 48_000;
const MAX_RETAINED_BYTES = 32 * 1024 * 1024;
const KEEP_MS = 5 * 60_000;
const Cursor = Schema.fromJsonString(
  Schema.Struct({ id: Schema.String, offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) }),
);
const decodeCursor = Schema.decodeOption(Cursor);
const encodeCursor = Schema.encodeSync(Cursor);
// Tool handlers return JSON data; preserve its exact encoding for continuation.
export const resultJson = <A>(value: A) => JSON.stringify(value);
const bytes = (text: string) => new TextEncoder().encode(text).length;
export const responseBytes = (json: string) =>
  bytes(
    `{"content":[{"type":"text","text":${resultJson(json)}}],"structuredContent":${json},"isError":false}`,
  ) + 1024;

/** Only oversized responses are retained, privately per tool/client, for five minutes. */
export const makeResponses = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const saved = new Map<
    string,
    { tool: string; client: string; json: string; bytes: number; until: number }
  >();
  let retained = 0;
  const remove = (id: string) => {
    retained -= saved.get(id)?.bytes ?? 0;
    saved.delete(id);
  };
  const fragment = (id: string, json: string, offset: number): typeof ResponseFragment.Type => {
    const build = (length: number) => {
      const end = offset + length;
      return {
        _tag: "response-fragment" as const,
        encoding: "json" as const,
        offset,
        totalCharacters: json.length,
        text: json.slice(offset, end),
        nextResponseCursor: end < json.length ? encodeCursor({ id, offset: end }) : null,
        truncated: end < json.length,
        message:
          "Oversized response split into JSON fragments. Concatenate text by offset and decode the original success schema. Repeat the original parameters with responseCursor: nextResponseCursor on this same tool to read the rest.",
      };
    };
    let low = 1;
    let high = Math.min(8_000, json.length - offset);
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (responseBytes(resultJson(build(middle))) <= RESPONSE_BYTES) low = middle;
      else high = middle - 1;
    }
    return build(low);
  };
  return <A, E, R>(
    tool: string,
    input: typeof ResponseInput.Type,
    run: () => Effect.Effect<A, E, R>,
  ) =>
    Effect.gen(function* () {
      const client = (yield* CurrentClient)?.name ?? "";
      const now = yield* Clock.currentTimeMillis;
      for (const [id, entry] of saved) if (entry.until <= now) remove(id);
      if (input.responseCursor !== undefined) {
        const cursor = decodeCursor(input.responseCursor);
        if (Option.isNone(cursor))
          return yield* fail("invalid", "Invalid response cursor. Start the read again.");
        const entry = saved.get(cursor.value.id);
        if (
          entry === undefined ||
          entry.tool !== tool ||
          entry.client !== client ||
          cursor.value.offset >= entry.json.length
        )
          return yield* fail(
            "conflict",
            "The response snapshot expired or belongs to another read. Start again.",
          );
        return fragment(cursor.value.id, entry.json, cursor.value.offset);
      }
      const result = yield* run();
      const json = resultJson(result);
      if (responseBytes(json) <= RESPONSE_BYTES) return result;
      const size = bytes(json);
      if (size > MAX_RETAINED_BYTES)
        return yield* fail(
          "failed",
          "This response exceeds 32 MB. Narrow the read or lower limit, then try again.",
        );
      for (const [id] of saved) {
        if (retained + size <= MAX_RETAINED_BYTES) break;
        remove(id);
      }
      const id = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      saved.set(id, { tool, client, json, bytes: size, until: now + KEEP_MS });
      retained += size;
      return fragment(id, json, 0);
    });
});
