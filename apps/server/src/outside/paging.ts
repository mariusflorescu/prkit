import * as Crypto from "effect/Crypto";
import { Hex } from "effect/encoding";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { fail } from "./errors.ts";

import type { PageInput } from "./pageSchemas.ts";
export type { PageInput } from "./pageSchemas.ts";

const Cursor = Schema.fromJsonString(
  Schema.Struct({
    scope: Schema.String,
    offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
);
const decodeCursor = Schema.decodeOption(Cursor);
const encodeCursor = Schema.encodeSync(Cursor);
/** Leave room for the enclosing tool result. Text fragments are bounded before paging. */
const PAGE_BYTES = 48_000;
export const TEXT_CHARS = 8_000;

const page = <A>(items: ReadonlyArray<A>, input: PageInput, scope: string, crypto: Crypto.Crypto) =>
  Effect.gen(function* () {
    const identity = Hex.encode(yield* crypto.digest("SHA-256", new TextEncoder().encode(scope)));
    const cursor = input.cursor === undefined ? null : decodeCursor(input.cursor);
    if (cursor !== null && (Option.isNone(cursor) || cursor.value.scope !== identity))
      return yield* fail(
        "invalid",
        "This cursor belongs to another read or the data changed. Start again without cursor.",
      );
    const offset = cursor !== null && Option.isSome(cursor) ? cursor.value.offset : 0;
    if (offset > items.length)
      return yield* fail("invalid", "This page no longer exists. Start again without cursor.");
    const selected: Array<A> = [];
    let bytes = 0;
    for (const item of items.slice(offset, offset + (input.limit ?? 20))) {
      // @effect-diagnostics-next-line preferSchemaOverJson:off -- Only measure the encoded size; the tool owns the result schema.
      const size = new TextEncoder().encode(JSON.stringify(item)).length;
      if (selected.length > 0 && bytes + size > PAGE_BYTES) break;
      selected.push(item);
      bytes += size;
    }
    const next = offset + selected.length;
    const truncated = next < items.length;
    return {
      items: selected,
      total: items.length,
      nextCursor: truncated ? encodeCursor({ scope: identity, offset: next }) : null,
      truncated,
      message: truncated ? "Truncated. Read the next page with nextCursor." : null,
    };
  });

export const textParts = (text: string) => {
  const parts: Array<{ offset: number; text: string }> = [];
  for (let offset = 0; offset < text.length; offset += TEXT_CHARS)
    parts.push({ offset, text: text.slice(offset, offset + TEXT_CHARS) });
  return parts.length === 0 ? [{ offset: 0, text: "" }] : parts;
};

export const makePager = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  return <A>(items: ReadonlyArray<A>, input: PageInput, scope: string) =>
    page(items, input, scope, crypto);
});
