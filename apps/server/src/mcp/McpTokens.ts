import type { AttemptId, FixerId, FixerTurnId, QuestionId, ReviewId } from "@prkit/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { Base64Url, Hex } from "effect/encoding";

/** Who an `/mcp` request speaks for: a guide attempt's turn, a fix turn, or an answer to a question. */
export type McpCaller =
  | { readonly _tag: "guide"; readonly attemptId: AttemptId; readonly reviewId: ReviewId }
  | { readonly _tag: "fixer"; readonly turnId: FixerTurnId; readonly fixerId: FixerId }
  | { readonly _tag: "ask"; readonly questionId: QuestionId; readonly reviewId: ReviewId };

/**
 * Bearer tokens for `/mcp`, one per agent turn. Only their SHA-256 digests are kept,
 * in memory, so a server restart revokes every token.
 */
export class McpTokens extends Context.Service<McpTokens, Effect.Success<typeof make>>()(
  "@prkit/server/mcp/McpTokens",
) {}

export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const callers = new Map<string, McpCaller>();
  const digest = (token: string) =>
    crypto.digest("SHA-256", new TextEncoder().encode(token)).pipe(Effect.map(Hex.encode));

  /** A fresh token for one turn, revoked when the scope closes. */
  const issue = (caller: McpCaller) =>
    Effect.acquireRelease(
      Effect.gen(function* () {
        const token = Base64Url.encode(yield* crypto.randomBytes(32));
        const hash = yield* digest(token);
        callers.set(hash, caller);
        return { token: Redacted.make(token), hash };
      }),
      ({ hash }) => Effect.sync(() => callers.delete(hash)),
    ).pipe(Effect.map(({ token }) => token));

  const resolve = (token: string) =>
    token === ""
      ? Effect.succeed(null)
      : digest(token).pipe(
          Effect.map((hash) => callers.get(hash) ?? null),
          Effect.catchTag("PlatformError", () => Effect.succeed(null)),
        );

  /** Drops every token of an attempt, for when it ends outside the turn's own scope. */
  const revokeAttempt = (attemptId: AttemptId) =>
    Effect.sync(() => {
      for (const [hash, caller] of callers)
        if (caller._tag === "guide" && caller.attemptId === attemptId) callers.delete(hash);
    });
  /** The same for a fix turn. */
  const revokeTurn = (turnId: FixerTurnId) =>
    Effect.sync(() => {
      for (const [hash, caller] of callers)
        if (caller._tag === "fixer" && caller.turnId === turnId) callers.delete(hash);
    });

  return { issue, resolve, revokeAttempt, revokeTurn };
});

export const layer = Layer.effect(McpTokens, make);
