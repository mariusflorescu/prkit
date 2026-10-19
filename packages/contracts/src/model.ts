import * as Order from "effect/Order";
import * as Schema from "effect/Schema";

export const ModelOptionChoice = Schema.Struct({
  id: Schema.NonEmptyString,
  label: Schema.NonEmptyString,
  description: Schema.optionalKey(Schema.String),
  isDefault: Schema.optionalKey(Schema.Boolean),
});
export type ModelOptionChoice = typeof ModelOptionChoice.Type;

export const SelectOptionDescriptor = Schema.Struct({
  id: Schema.NonEmptyString,
  label: Schema.NonEmptyString,
  type: Schema.Literal("select"),
  options: Schema.NonEmptyArray(ModelOptionChoice),
  /** Values the agent gets as a word in the prompt rather than a setting (Claude's "ultrathink"). */
  promptInjectedValues: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type SelectOptionDescriptor = typeof SelectOptionDescriptor.Type;

export const BooleanOptionDescriptor = Schema.Struct({
  id: Schema.NonEmptyString,
  label: Schema.NonEmptyString,
  type: Schema.Literal("boolean"),
});
export type BooleanOptionDescriptor = typeof BooleanOptionDescriptor.Type;

/** One setting a model advertises: effort, fast mode, service tier, context window. */
export const ModelOptionDescriptor = Schema.Union([
  SelectOptionDescriptor,
  BooleanOptionDescriptor,
]);
export type ModelOptionDescriptor = typeof ModelOptionDescriptor.Type;

/** A choice the user made. Settings without one use the model's default. */
export const ModelOptionSelection = Schema.Struct({
  id: Schema.NonEmptyString,
  value: Schema.Union([Schema.String, Schema.Boolean]),
});
export type ModelOptionSelection = typeof ModelOptionSelection.Type;

export type ResolvedModelOption =
  | { readonly type: "select"; readonly descriptor: SelectOptionDescriptor; readonly value: string }
  | {
      readonly type: "boolean";
      readonly descriptor: BooleanOptionDescriptor;
      readonly value: boolean;
    };

const defaultChoice = (descriptor: SelectOptionDescriptor) =>
  (descriptor.options.find((option) => option.isDefault === true) ?? descriptor.options[0]).id;

/** Every descriptor with its value: the selection's when it is valid, else the default. */
export const resolveModelOptions = (
  descriptors: ReadonlyArray<ModelOptionDescriptor>,
  selections: ReadonlyArray<ModelOptionSelection>,
): ReadonlyArray<ResolvedModelOption> =>
  descriptors.map((descriptor) => {
    const chosen = selections.find((selection) => selection.id === descriptor.id)?.value;
    if (descriptor.type === "boolean")
      return { type: "boolean", descriptor, value: typeof chosen === "boolean" ? chosen : false };
    const valid =
      typeof chosen === "string" && descriptor.options.some((option) => option.id === chosen);
    return { type: "select", descriptor, value: valid ? chosen : defaultChoice(descriptor) };
  });

const bySettingId = Order.mapInput(Order.String, (selection: ModelOptionSelection) => selection.id);

/**
 * The settings a turn runs with: every setting the model takes, explicit, so a resumed session
 * doesn't keep an earlier choice. Sorted by id, so the stored text of two equal settings is equal.
 * A model missing from the catalog passes the stored selections through.
 */
export const explicitModelOptions = (
  model: { readonly options: ReadonlyArray<ModelOptionDescriptor> } | undefined,
  selections: ReadonlyArray<ModelOptionSelection>,
): ReadonlyArray<ModelOptionSelection> =>
  model === undefined
    ? selections
    : resolveModelOptions(model.options, selections)
        .map((option) => ({ id: option.descriptor.id, value: option.value }))
        .toSorted(bySettingId);

/** The selections that still apply to a model, for keeping choices across a model switch. */
export const keepModelOptions = (
  descriptors: ReadonlyArray<ModelOptionDescriptor>,
  selections: ReadonlyArray<ModelOptionSelection>,
): ReadonlyArray<ModelOptionSelection> =>
  selections.filter((selection) =>
    resolveModelOptions(descriptors, [selection]).some(
      (resolved) => resolved.descriptor.id === selection.id && resolved.value === selection.value,
    ),
  );

/** Sets one option, replacing an earlier choice for it. */
export const withModelOption = (
  selections: ReadonlyArray<ModelOptionSelection>,
  next: ModelOptionSelection,
): ReadonlyArray<ModelOptionSelection> => [
  ...selections.filter((selection) => selection.id !== next.id),
  next,
];

/**
 * A short label for a model's settings: the first select always ("High"), other
 * selects only when changed from their default, and booleans only when on.
 */
export const modelOptionsLabel = (
  descriptors: ReadonlyArray<ModelOptionDescriptor>,
  selections: ReadonlyArray<ModelOptionSelection>,
) =>
  resolveModelOptions(descriptors, selections)
    .flatMap((resolved, index) => {
      if (resolved.type === "boolean") return resolved.value ? [resolved.descriptor.label] : [];
      const isFirst = descriptors.findIndex((descriptor) => descriptor.type === "select") === index;
      if (!isFirst && resolved.value === defaultChoice(resolved.descriptor)) return [];
      return [
        resolved.descriptor.options.find((option) => option.id === resolved.value)?.label ??
          resolved.value,
      ];
    })
    .join(" · ");
