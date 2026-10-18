import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { HttpRouter, HttpServerResponse, HttpStaticServer } from "effect/http";

import { AppearanceStore } from "./appearance/AppearanceStore.ts";
import * as ServerConfig from "./config.ts";
import { buildId } from "./build.ts";

export class Readiness extends Context.Service<Readiness, Effect.Success<typeof makeReadiness>>()(
  "@prkit/server/http/Readiness",
) {}

const makeReadiness = Effect.gen(function* () {
  const ready = yield* Ref.make(false);
  return { markReady: Ref.set(ready, true), isReady: Ref.get(ready) };
});

export const layerReadiness = Layer.effect(Readiness, makeReadiness);

/** 503 until startup has finished, so a caller polling it sees what the ready line promises. */
export const layerHealthRoute = HttpRouter.add(
  "GET",
  "/health",
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const ready = yield* (yield* Readiness).isReady;
    return HttpServerResponse.jsonUnsafe(
      { ok: ready, version: config.version, buildId, home: config.home },
      { status: ready ? 200 : 503 },
    );
  }),
);

/**
 * The stored theme as a script, for index.html to load before the first paint. The page's origin
 * (and so its localStorage) changes with the port, but this answer never does. It sets one
 * attribute and nothing else, so it needs no token.
 */
export const layerAppearanceRoute = HttpRouter.add(
  "GET",
  "/appearance.js",
  Effect.gen(function* () {
    const appearance = yield* AppearanceStore;
    const theme = yield* appearance.current();
    return HttpServerResponse.text(`document.documentElement.dataset.theme="${theme}";`, {
      contentType: "text/javascript",
      headers: { "cache-control": "no-store" },
    });
  }),
);

/** Serves the built web UI with SPA fallback when `--web-dist` is set; dev serves it from Vite. */
export const layerStaticRoute = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return Option.match(config.webDist, {
      onNone: () => Layer.empty,
      onSome: (root) => HttpStaticServer.layer({ root, spa: true, cacheControl: "no-cache" }),
    });
  }),
);
