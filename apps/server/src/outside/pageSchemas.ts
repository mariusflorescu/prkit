import * as Schema from "effect/Schema";

export const PageFields = {
  cursor: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2000))),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
};
export const PageInput = Schema.Struct(PageFields);
export type PageInput = typeof PageInput.Type;
export const PageInfo = {
  nextCursor: Schema.NullOr(Schema.String),
  total: Schema.Int,
  truncated: Schema.Boolean,
  message: Schema.NullOr(Schema.String),
};
export const pageSchema = <S extends Schema.Top>(item: S) =>
  Schema.Struct({ items: Schema.Array(item), ...PageInfo });
