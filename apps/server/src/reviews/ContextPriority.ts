import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import type { Priority } from "../github/budget.ts";

/**
 * The GitHub priority of an attempt's context reads (checks, threads, linked issues). The
 * attempt's other reads keep theirs: a refused reviewTarget would fail the guide. Set around
 * the call that starts an attempt; the attempt's fiber inherits it through forkIn.
 */
export const ContextPriority = Context.Reference<Priority>(
  "@prkit/server/reviews/ContextPriority/ContextPriority",
  { defaultValue: () => "interactive" },
);

/** Starts an attempt nobody clicked for (new commits, auto mode, a restart): its context reads go in the background. */
export const unattended = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, ContextPriority, "background");
