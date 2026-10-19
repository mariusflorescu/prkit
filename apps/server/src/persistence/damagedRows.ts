import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** A stored row that doesn't decode: its table, its id when it has one, and what's wrong. */
export class DamagedRow extends Schema.TaggedError<DamagedRow>()("DamagedRow", {
  table: Schema.String,
  id: Schema.NullOr(Schema.String),
  problem: Schema.String,
}) {}

const decodeId = Schema.decodeUnknownOption(Schema.Struct({ id: Schema.String }));

/** Decodes each row on its own, as `[rows, damaged]`, so one row's damage fails alone. */
export const decodeEach = <A, I>(table: string, schema: Schema.Codec<A, I>) => {
  const decode = Schema.decodeUnknownEffect(schema);
  return <Row>(rows: ReadonlyArray<Row>) =>
    Effect.partition(rows, (row) =>
      decode(row).pipe(
        Effect.mapError(
          (error) =>
            new DamagedRow({
              table,
              id: Option.getOrNull(Option.map(decodeId(row), (stored) => stored.id)),
              problem: error.message,
            }),
        ),
      ),
    );
};

export const logDamaged = (row: DamagedRow) =>
  Effect.logWarning("Left out a stored row prkit can't read").pipe(
    Effect.annotateLogs({ table: row.table, id: row.id ?? "", problem: row.problem }),
  );

/** A list's rows that decode. Each one left out is logged, and the rest still read. */
export const decodeReadable = <A, I>(table: string, schema: Schema.Codec<A, I>) => {
  const each = decodeEach(table, schema);
  return <Row>(rows: ReadonlyArray<Row>) =>
    each(rows).pipe(
      Effect.tap(([, damaged]) => Effect.forEach(damaged, logDamaged, { discard: true })),
      Effect.map(([readable]) => readable),
    );
};
