import { pullRequestKey } from "@prkit/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import { inBackground } from "../github/GitHubApi.ts";
import { PullRequests } from "../pullRequests/PullRequests.ts";
import { unattended } from "./ContextPriority.ts";
import { GuideSettingsStore } from "./GuideSettingsStore.ts";
import { Reviews } from "./Reviews.ts";

/**
 * Auto mode (Settings > Guides): writes a guide for each open review request on
 * the accounts the user turned it on for. One auto review runs at a time, and a
 * PR that already has a review is never started again.
 */
export class AutoGuides extends Context.Service<AutoGuides, Effect.Success<typeof make>>()(
  "@prkit/server/reviews/AutoGuides",
) {}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const reviews = yield* Reviews;
  const settings = yield* GuideSettingsStore;
  const pullRequests = yield* PullRequests;
  const once = yield* Semaphore.make(1);
  const devRequested = new Set(config.devReviewRequested);

  const tick = once
    .withPermits(1)(
      Effect.gen(function* () {
        const { autoAccounts } = yield* settings.get();
        if (autoAccounts.length === 0 || (yield* reviews.autoRunning) > 0) return;
        const enabled = new Set(autoAccounts);
        const inbox = yield* inBackground(pullRequests.inbox({ _tag: "cached" }));
        for (const entry of inbox.entries) {
          const key = pullRequestKey(entry.ref);
          const requested = entry.reasons.includes("review-requested") || devRequested.has(key);
          if (
            !requested ||
            !enabled.has(entry.accountId) ||
            entry.state !== "open" ||
            entry.isDraft
          )
            continue;
          if (!(yield* unattended(reviews.autoGenerate(key, entry.accountId)))) continue;
          yield* Effect.logInfo("Auto mode started a guide").pipe(
            Effect.annotateLogs({ key, accountId: entry.accountId }),
          );
          return;
        }
      }),
    )
    .pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) => Effect.logWarning("Auto mode couldn't check review requests", cause),
      ),
    );

  yield* tick.pipe(
    Effect.repeat(Schedule.spaced(Duration.millis(config.watchIntervalMs))),
    Effect.forkScoped,
  );
  // A switch turned on starts the first guide now, not a minute later.
  yield* Stream.fromPubSub(settings.changes).pipe(
    Stream.runForEach(() => tick),
    Effect.forkScoped,
  );
  return { tick };
});

export const layer = Layer.effect(AutoGuides, make);
