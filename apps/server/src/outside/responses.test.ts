import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { CurrentClient } from "../mcp/outside/access.ts";
import { makePager } from "./paging.ts";
import { ResponseFragment } from "./responseSchemas.ts";
import { makeResponses, responseBytes, resultJson } from "./responses.ts";

describe("outside response boundaries", () => {
  it("refuses changed ordered results, including changed values under the same ids", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const page = yield* makePager;
        const rows = [
          { id: "a", value: 1 },
          { id: "b", value: 2 },
        ];
        const first = yield* page(rows, { limit: 1 }, "same account");
        if (first.nextCursor === null) throw new Error("Expected another page");
        const next = yield* page(rows, { cursor: first.nextCursor }, "same account");
        expect(next.items).toEqual([rows[1]]);
        for (const changed of [
          [rows[1], rows[0]],
          [{ id: "new", value: 0 }, ...rows],
          [{ id: "a", value: 3 }, rows[1]],
        ]) {
          const failure = yield* page(changed, { cursor: first.nextCursor }, "same account").pipe(
            Effect.flip,
          );
          expect(failure).toMatchObject({
            code: "conflict",
            message: expect.stringContaining("list changed, start again"),
          });
        }
        const retargeted = yield* page(
          rows,
          { cursor: first.nextCursor },
          "same account/new base/new merge base",
        ).pipe(Effect.flip);
        expect(retargeted).toMatchObject({ code: "conflict" });
      }).pipe(Effect.provide(NodeServices.layer)),
    );
  });

  it("caps the complete encoded response and reconstructs oversized items and progress metadata exactly", async () => {
    const text = 'control:\u0000 " \\ 😀\n'.repeat(20_000);
    const data = {
      items: [{ id: "thread", comments: [{ body: text }] }],
      attempt: {
        files: Array.from({ length: 500 }, (_, id) => ({ id, note: text.slice(0, 100) })),
      },
      draft: { outline: text },
      status: "writing",
    };
    await Effect.runPromise(
      Effect.gen(function* () {
        const respond = yield* makeResponses;
        let calls = 0;
        const run = () =>
          Effect.sync(() => {
            calls++;
            return data;
          });
        let result = yield* respond("read_guide_progress", {}, run);
        let joined = "";
        while (Schema.is(ResponseFragment)(result)) {
          expect(result.offset).toBe(joined.length);
          expect(responseBytes(resultJson(result))).toBeLessThanOrEqual(48_000);
          joined += result.text;
          if (result.nextResponseCursor === null) break;
          const refused = yield* respond(
            "another tool",
            { responseCursor: result.nextResponseCursor },
            run,
          ).pipe(Effect.flip);
          expect(refused.code).toBe("conflict");
          result = yield* respond(
            "read_guide_progress",
            { responseCursor: result.nextResponseCursor },
            run,
          );
        }
        expect(joined).toBe(resultJson(data));
        expect(calls).toBe(1);
      }).pipe(
        Effect.provideService(CurrentClient, { name: "reader", access: "read" }),
        Effect.provide(NodeServices.layer),
      ),
    );
  });
});
