import type { OutsideAccess } from "@prkit/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Struct from "effect/Struct";
import type { Tool, Toolkit } from "effect/ai";

import { StartedBy } from "../../outside/StartedBy.ts";
import { OutsideToolFailure } from "../../outside/schemas.ts";

/** What an outside tool does: it only reads, or it starts work in prkit. */
export type ToolLevel = "reads" | "starts-work";

/** The level a tool is listed and called at, as an annotation on the tool itself. */
export class OutsideToolLevel extends Context.Service<OutsideToolLevel, ToolLevel>()(
  "@prkit/server/mcp/outside/access/OutsideToolLevel",
) {}

/**
 * Set by the endpoint's auth for each request: the client by the name it gave in
 * `initialize`, and the access level at the moment the request came in. A reference with
 * a default, so registration never captures one.
 */
export const CurrentClient = Context.Reference<{
  readonly name: string;
  readonly access: OutsideAccess;
} | null>("@prkit/server/mcp/outside/access/CurrentClient", { defaultValue: () => null });

const builtHere: unique symbol = Symbol("@prkit/server/mcp/outside/access/builtHere");

let declare: <P, A, E, R>(
  level: ToolLevel,
  handle: (params: P) => Effect.Effect<A, E, R>,
) => Declaration<(params: P) => Effect.Effect<A, E, R>>;

type CheckedHandlerOf<D> = D extends Declaration<infer Handler> ? Handler : never;
interface CheckedHandler extends Struct.Lambda {
  <Handler>(declaration: Declaration<Handler>): Handler;
  readonly "~lambda.out": CheckedHandlerOf<this["~lambda.in"]>;
}
let checkedHandler: CheckedHandler;

/**
 * Every outside tool's handler is built by `reads` or `startsWork` below, which say what it
 * does and check the caller before it runs. `toLayer` accepts only these, and the endpoint
 * registers only what `toLayer` built, so a handler without a level does not compile, and one
 * whose level differs from its tool's stops the server at startup. The class is nominal: a
 * private field and constructor, and a token only this module holds.
 */
export class Declaration<out Handler> {
  readonly #handle: Handler;
  readonly level: ToolLevel;
  private constructor(token: symbol, level: ToolLevel, handle: Handler) {
    if (token !== builtHere)
      throw new TypeError("Only mcp/outside/access.ts declares outside tool handlers.");
    this.level = level;
    this.#handle = handle;
  }
  static {
    declare = (level, handle) => new Declaration(builtHere, level, handle);
    checkedHandler = Struct.lambda<CheckedHandler>((declaration) => declaration.#handle);
  }
}

const noClient = new OutsideToolFailure({
  code: "not-allowed",
  message: "This call didn't come through prkit's outside agent endpoint.",
});
const readOnly = new OutsideToolFailure({
  code: "not-allowed",
  message:
    "This tool starts work in prkit, and outside agents are set to Read only. The owner can change that in prkit > Settings > Outside agents.",
});

/** Changes nothing; both levels may call it. */
export const reads = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare("reads", (params: P) =>
    Effect.gen(function* () {
      if ((yield* CurrentClient) === null) return yield* noClient;
      return yield* handle(params);
    }),
  );

/**
 * Starts work in prkit (opens a PR, starts a guide, sends work to the fix agent): only at
 * "Read and start work", checked on every call because the level can change while a client
 * is connected. The work records the client as who started it.
 */
export const startsWork = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare("starts-work", (params: P) =>
    Effect.gen(function* () {
      const client = yield* CurrentClient;
      if (client === null) return yield* noClient;
      if (client.access !== "work") return yield* readOnly;
      return yield* handle(params).pipe(Effect.provideService(StartedBy, client.name));
    }),
  );

type Declarations<Handlers> = {
  readonly [Name in keyof Handlers]: Declaration<Handlers[Name]>;
};

const checkedHandlers = <Handlers>(declarations: Declarations<Handlers>): Handlers =>
  Struct.map(declarations, checkedHandler);

/** Each tool's name and level, in the toolkit's order. */
export const levelsOf = <Tools extends Record<string, Tool.Any>>(toolkit: Toolkit.Toolkit<Tools>) =>
  Object.values(toolkit.tools).map((tool) => ({
    name: tool.name,
    level: Context.getOrUndefined(tool.annotations, OutsideToolLevel),
  }));

/** `Toolkit.toLayer` for handlers that each declare their level, matching their tool's. */
export const toLayer = <Tools extends Record<string, Tool.Any>, EX, RX>(
  toolkit: Toolkit.Toolkit<Tools>,
  build: Effect.Effect<Declarations<Toolkit.HandlersFrom<Tools>>, EX, RX>,
) =>
  toolkit.toLayer(
    Effect.gen(function* () {
      const declarations = yield* build;
      const levels = new Map(levelsOf(toolkit).map((tool) => [tool.name, tool.level]));
      const declared: ReadonlyArray<readonly [string, { readonly level: ToolLevel }]> =
        Object.entries(declarations);
      for (const [name, declaration] of declared)
        if (levels.get(name) !== declaration.level)
          return yield* Effect.die(
            `Outside tool ${name} is declared ${declaration.level} but listed as ${levels.get(name) ?? "nothing"}.`,
          );
      return checkedHandlers<Toolkit.HandlersFrom<Tools>>(declarations);
    }),
  );
