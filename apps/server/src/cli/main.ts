// @effect-diagnostics preferSchemaOverJson:off
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Resolve the launcher home before any server runtime loads.
import * as NodePath from "node:path";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import { Argument, Command, Flag } from "effect/cli";

import packageJson from "../../package.json" with { type: "json" };
import { callTool, CliFailure } from "./client.ts";
import {
  commandParameters,
  mappings,
  toolkit,
  type CommandMapping,
  type ToolName,
} from "./commands.ts";
import { continuationOutput, humanOutput } from "./output.ts";

type Value = Option.Option<Schema.Json>;
type Input = Record<string, Flag.Flag<Value> | Argument.Argument<Value>>;
const JsonText = Schema.fromJsonString(Schema.Json);

const textValue = (text: string, ast: SchemaAST.AST): Schema.Json => {
  if (ast._tag === "Objects" || ast._tag === "Arrays") return Schema.decodeSync(JsonText)(text);
  if (ast._tag === "Number") {
    const number = Number(text);
    if (!Number.isFinite(number)) throw new Error("Expected a number.");
    return number;
  }
  if (ast._tag === "Boolean") {
    if (text !== "true" && text !== "false") throw new Error("Expected true or false.");
    return text === "true";
  }
  if (ast._tag === "Union") {
    if (text === "null" && ast.types.some((type) => type._tag === "Null")) return null;
    if (ast.types.some((type) => type._tag === "Objects" || type._tag === "Arrays"))
      return Schema.decodeSync(JsonText)(text);
  }
  return text;
};

const repository = (text: string, host: Schema.Json | undefined) => {
  const match = /^([^/]+)\/([^/]+)$/.exec(text);
  const owner = match?.[1];
  const repo = match?.[2];
  if (owner === undefined || repo === undefined)
    throw new Error("Name the repository as owner/repo.");
  return { owner, repo, host: host ?? "github.com" };
};

const parameter = (name: string, ast: SchemaAST.AST): Flag.Flag<Schema.Json> => {
  switch (ast._tag) {
    case "Boolean":
      return Flag.Boolean(name);
    case "Number":
      return Flag.Int(name);
    case "Arrays":
      return Flag.String(name).pipe(
        Flag.mapTryCatch(
          (text): Schema.Json => {
            if (name === "option") {
              const index = text.indexOf("=");
              if (index < 1) throw new Error("Use --option key=value.");
              const value = text.slice(index + 1);
              return {
                id: text.slice(0, index),
                value: value === "true" ? true : value === "false" ? false : value,
              };
            }
            const item = ast.rest[0] ?? ast.elements[0];
            return item === undefined ? text : textValue(text, item);
          },
          (error) => (error instanceof Error ? error.message : `Invalid --${name}.`),
        ),
        Flag.atLeast(0),
      );
    default:
      return Flag.String(name).pipe(
        Flag.mapTryCatch(
          (text) =>
            name === "repo" && !text.startsWith("{") && text !== "null"
              ? text
              : textValue(text, ast),
          (error) => (error instanceof Error ? error.message : `Invalid --${name}.`),
        ),
      );
  }
};

const target = (
  pr: string,
  host: Schema.Json | undefined,
): Effect.Effect<Record<string, Schema.Json>, CliFailure> => {
  if (pr.startsWith("https://")) return Effect.succeed({ url: pr });
  const match = /^([^/]+)\/([^#]+)#([1-9]\d*)$/.exec(pr);
  const owner = match?.[1];
  const repo = match?.[2];
  const number = Number(match?.[3]);
  return owner === undefined || repo === undefined || !Number.isSafeInteger(number)
    ? Effect.fail(
        new CliFailure({ code: 2, message: "Name the PR by HTTPS URL or owner/repo#123." }),
      )
    : Effect.succeed({ owner, repo, number, host: host ?? "github.com" });
};

export const main = () => {
  const home = NodePath.resolve(
    process.env.PRKIT_HOME ?? NodePath.join(process.env.HOME ?? "", ".prkit"),
  );
  const root = Command.make("prkit").pipe(
    Command.withSharedFlags({
      json: Flag.Boolean("json").pipe(
        Flag.withDefault(false),
        Flag.withDescription("Print the tool's structured result as JSON."),
      ),
    }),
  );
  const leaf = (name: ToolName, mapping: CommandMapping) => {
    const tool = toolkit.tools[name];
    const input: Input = {};
    if (mapping.target)
      input.target = Argument.String(mapping.target === "pr" ? "pr" : "owner/repo").pipe(
        Argument.map((value) => Option.some<Schema.Json>(value)),
      );
    for (const field of commandParameters(name, mapping)) {
      const flag = parameter(field.name, field.ast).pipe(
        Flag.withDescription(SchemaAST.resolveDescription(field.ast) ?? field.key),
      );
      input[field.key] = flag.pipe(Flag.optional);
    }
    return Command.make(mapping.path.at(-1) ?? name, input, (values) =>
      Effect.gen(function* () {
        const { json } = yield* root;
        const args: Record<string, Schema.Json> = {};
        for (const [key, value] of Object.entries(values))
          if (
            key !== "target" &&
            Option.isSome(value) &&
            !(Array.isArray(value.value) && value.value.length === 0)
          )
            args[key] = value.value;
        if (mapping.target) {
          const selected = values.target;
          if (
            selected === undefined ||
            Option.isNone(selected) ||
            typeof selected.value !== "string"
          )
            return yield* new CliFailure({
              code: 2,
              message: "Name the pull request or repository.",
            });
          const text = selected.value;
          Object.assign(
            args,
            mapping.target === "pr"
              ? yield* target(text, args.host)
              : yield* Effect.try({
                  try: () => repository(text, args.host),
                  catch: (error) =>
                    new CliFailure({
                      code: 2,
                      message:
                        error instanceof Error
                          ? error.message
                          : "Name the repository as owner/repo.",
                    }),
                }),
          );
        }
        if (typeof args.repository === "string") {
          const text = args.repository;
          const selected = yield* Effect.try({
            try: () => repository(text, args.host),
            catch: (error) =>
              new CliFailure({
                code: 2,
                message:
                  error instanceof Error ? error.message : "Name the repository as owner/repo.",
              }),
          });
          args.repository = { host: selected.host, owner: selected.owner, name: selected.repo };
          if (name === "save_inbox_filters") {
            if (typeof args.account !== "string")
              return yield* new CliFailure({
                code: 2,
                message:
                  "Saving --repo owner/repo also needs --account. Or pass repository JSON with accountIds.",
              });
            args.repository = { ...args.repository, accountIds: [args.account] };
          }
        }
        if (name === "generate_guide") {
          if (args.stack === "this") args.stack = "this-pr";
          else if (args.stack === "all") args.stack = "whole-stack";
          else if (typeof args.stack === "string" && /^\d+(?:,\d+)*$/.test(args.stack)) {
            args.layers = args.stack.split(",").map(Number);
            args.stack = "chosen-layers";
          }
        }
        yield* Schema.decodeUnknownEffect(
          Schema.make<Schema.Codec<Schema.Json>>(tool.parametersSchema.ast),
        )(args).pipe(
          Effect.mapError((error) => new CliFailure({ code: 2, message: error.message })),
        );
        const result = yield* callTool(home, name, args);
        process.stdout.write(
          `${json ? JSON.stringify(result) : [humanOutput(result), continuationOutput(result, process.argv.slice(3))].filter(Boolean).join("\n\n")}\n`,
        );
      }),
    ).pipe(Command.withDescription(tool.description ?? name));
  };
  type TreeCommand = Command.Command<
    string,
    never,
    {},
    CliFailure,
    Command.CommandContext<"prkit">
  >;
  const branch = (path: readonly string[]): TreeCommand => {
    const entry = mappings.find(
      ([, mapping]) =>
        mapping.path.length === path.length &&
        mapping.path.every((part, index) => part === path[index]),
    );
    const base = entry === undefined ? Command.make(path.at(-1) ?? "prkit") : leaf(...entry);
    const children = [
      ...new Set(
        mappings.flatMap(([, mapping]) =>
          mapping.path.length > path.length &&
          path.every((part, index) => mapping.path[index] === part)
            ? mapping.path.slice(path.length, path.length + 1)
            : [],
        ),
      ),
    ];
    return children.length === 0
      ? base
      : base.pipe(Command.withSubcommands(children.map((child) => branch([...path, child]))));
  };
  const commands = [...new Set(mappings.map(([, mapping]) => mapping.path[0]))].map((part) =>
    branch([part]),
  );
  const usageFailure = () =>
    Effect.sync(() => {
      process.exitCode = 2;
    });
  NodeRuntime.runMain(
    Command.runWith(root.pipe(Command.withSubcommands(commands)), {
      version: process.env.PRKIT_APP_VERSION ?? packageJson.version,
    })(process.argv.slice(3)).pipe(
      Effect.catchTag("CliFailure", (error) =>
        Effect.sync(() => {
          process.stderr.write(`${error.message}\n`);
          process.exitCode = error.code;
        }),
      ),
      Effect.catchTags({
        DuplicateOption: usageFailure,
        InvalidValue: usageFailure,
        MissingArgument: usageFailure,
        MissingOption: usageFailure,
        UnexpectedArgument: usageFailure,
        UnknownSubcommand: usageFailure,
        UnrecognizedOption: usageFailure,
        UserError: usageFailure,
        ShowHelp: (error) => (error.errors.length > 0 ? usageFailure() : Effect.void),
      }),
      Effect.provide(NodeServices.layer),
    ),
  );
};
