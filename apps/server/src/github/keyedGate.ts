import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

export const makeKeyedGate = <K>(permits: number) => {
  const entries = new Map<K, { semaphore: Semaphore.Semaphore; users: number }>();
  return <A, E, R>(key: K, effect: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const entry = entries.get(key) ?? { semaphore: Semaphore.makeUnsafe(permits), users: 0 };
        entry.users++;
        entries.set(key, entry);
        return entry;
      }),
      (entry) => entry.semaphore.withPermits(1)(effect),
      (entry) =>
        Effect.sync(() => {
          entry.users--;
          if (entry.users === 0) entries.delete(key);
        }),
    );
};
