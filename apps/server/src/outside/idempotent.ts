import type { ReviewKey } from "@prkit/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import { Hex } from "effect/encoding";

import { fail } from "./errors.ts";
import { StartedBy } from "./StartedBy.ts";

const StoredRequests = Schema.Array(
  Schema.Struct({ input_hash: Schema.String, result: Schema.String }),
);
const encodeFingerprint = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(Schema.NullOr(Schema.Union([Schema.String, Schema.Number])))),
);

/**
 * Runs a tool's work once per client request: the tool, the client, the review (a pull request
 * or local changes) and its `clientRequestId`. A retry gets the first answer; the same id with other input is a
 * conflict. Answers are kept a day.
 */
export const makeIdempotent = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  /** One lock per request key: a slow call holds back only its own retries. */
  const locks = new Map<string, { readonly lock: Semaphore.Semaphore; users: number }>();
  const withLock = <A, E, R>(key: string, work: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const entry = locks.get(key) ?? { lock: Semaphore.makeUnsafe(1), users: 0 };
        entry.users += 1;
        locks.set(key, entry);
        return entry;
      }),
      (entry) => entry.lock.withPermits(1)(work),
      (entry) =>
        Effect.sync(() => {
          entry.users -= 1;
          if (entry.users === 0) locks.delete(key);
        }),
    );

  return <A, I, E, R>(
    request: {
      readonly tool: string;
      readonly clientRequestId: string | undefined;
      readonly key: ReviewKey;
      /** The input that names the request, in a fixed order. */
      readonly input: ReadonlyArray<string | number | null>;
    },
    schema: Schema.Codec<A, I>,
    work: Effect.Effect<A, E, R>,
  ) => {
    const { tool, clientRequestId, key } = request;
    if (clientRequestId === undefined) return work;
    const json = Schema.fromJsonString(schema);
    return Effect.gen(function* () {
      const client = (yield* StartedBy) ?? "";
      const hash = yield* crypto
        .digest("SHA-256", new TextEncoder().encode(encodeFingerprint(request.input)))
        .pipe(Effect.map(Hex.encode));
      return yield* withLock(
        [tool, client, key, clientRequestId].join("\u0000"),
        Effect.gen(function* () {
          const rows = yield* sql`SELECT input_hash, result FROM outside_requests
            WHERE tool = ${tool} AND client = ${client} AND pr_key = ${key}
              AND client_request_id = ${clientRequestId}`.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(StoredRequests)),
          );
          const earlier = rows[0];
          if (earlier !== undefined) {
            if (earlier.input_hash !== hash)
              return yield* fail(
                "conflict",
                "This clientRequestId was used for a different request. Use a new one.",
              );
            return yield* Schema.decodeEffect(json)(earlier.result);
          }
          const result = yield* work;
          const now = yield* DateTime.now;
          const at = DateTime.formatIso(now);
          const cutoff = DateTime.formatIso(DateTime.subtract(now, { days: 1 }));
          yield* sql`DELETE FROM outside_requests WHERE created_at < ${cutoff}`;
          yield* sql`INSERT INTO outside_requests
            (tool, client, pr_key, client_request_id, input_hash, result, created_at)
            VALUES (${tool}, ${client}, ${key}, ${clientRequestId}, ${hash},
              ${yield* Schema.encodeEffect(json)(result)}, ${at})`;
          return result;
        }),
      );
    });
  };
});
