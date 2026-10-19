import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";

/**
 * A GraphQL connection's `nodes`. GitHub's schema lets the list and each item be null (an
 * item it couldn't resolve, named by an error), and both read as nothing here.
 */
export const nodesOf = <S extends Schema.Top>(item: S) =>
  Schema.NullOr(Schema.Array(Schema.NullOr(item))).pipe(
    Schema.decodeTo(Schema.Array(Schema.toType(item)), {
      decode: SchemaGetter.transform((nodes) => (nodes ?? []).filter((node) => node !== null)),
      encode: SchemaGetter.forbidden(() => "GitHub's answers are only read."),
    }),
  );
