import * as Schema from "effect/Schema";

export const ResponseFields = {
  responseCursor: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2000))),
};
export const ResponseInput = Schema.Struct(ResponseFields);
export const ResponseFragment = Schema.TaggedStruct("response-fragment", {
  encoding: Schema.Literal("json"),
  offset: Schema.Int,
  totalCharacters: Schema.Int,
  text: Schema.String,
  nextResponseCursor: Schema.NullOr(Schema.String),
  truncated: Schema.Boolean,
  message: Schema.String,
});
export const limited = <S extends Schema.Top>(schema: S) =>
  Schema.Union([schema, ResponseFragment]);
