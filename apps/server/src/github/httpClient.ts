import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as Undici from "@effect/platform-node/Undici";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export const layer = NodeHttpClient.layerUndiciNoDispatcher.pipe(
  Layer.provide(
    Layer.effect(
      NodeHttpClient.Dispatcher,
      Effect.acquireRelease(
        // HTTP/2 POSTs can trap Node in SendPendingData, preventing even request timeouts.
        Effect.sync(() => new Undici.Agent({ allowH2: false, maxResponseSize: 16 * 1024 * 1024 })),
        (dispatcher) => Effect.promise(() => dispatcher.destroy()),
      ),
    ),
  ),
);
