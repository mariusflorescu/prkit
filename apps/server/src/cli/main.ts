// @effect-diagnostics preferSchemaOverJson:off
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Resolve the launcher home before any server runtime loads.
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import { Argument, Command, Flag } from "effect/cli";

import packageJson from "../../package.json" with { type: "json" };
import { callTool, CliFailure } from "./client.ts";
import { flagName, mappings, toolkit, type ToolName } from "./commands.ts";
import { humanOutput } from "./output.ts";

type Value = Option.Option<Schema.Json>;
type Input = Record<string, Flag.Flag<Value> | Argument.Argument<Value>>;
const JsonText = Schema.fromJsonString(Schema.Json);

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
            const item = ast.rest[0];
            return item?._tag === "Objects" || item?._tag === "Arrays"
              ? Schema.decodeSync(JsonText)(text)
              : text;
          },
          (error) => (error instanceof Error ? error.message : `Invalid --${name}.`),
        ),
        Flag.atLeast(0),
      );
    case "Objects":
      return Flag.String(name).pipe(Flag.withSchema(JsonText));
    default:
      return Flag.String(name);
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

export const main = async () => {
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
  const leaf = (name: ToolName, mapping: (typeof mappings)[number][1]) => {
    const tool = toolkit.tools[name];
    const ast = SchemaAST.toEncoded(tool.parametersSchema.ast);
    const input: Input = {};
    if (mapping.target)
      input.pr = Argument.String("pr").pipe(
        Argument.map((value) => Option.some<Schema.Json>(value)),
      );
    if (ast._tag === "Objects")
      for (const field of ast.propertySignatures) {
        if (typeof field.name !== "string") continue;
        if (mapping.target && ["url", "owner", "repo", "number"].includes(field.name)) continue;
        const flag = parameter(flagName(field.name), field.type).pipe(
          Flag.withDescription(SchemaAST.resolveDescription(field.type) ?? field.name),
        );
        input[field.name] = flag.pipe(Flag.optional);
      }
    return Command.make(mapping.path.at(-1) ?? name, input, (values) =>
      Effect.gen(function* () {
        const { json } = yield* root;
        const args: Record<string, Schema.Json> = {};
        for (const [key, value] of Object.entries(values))
          if (
            key !== "pr" &&
            Option.isSome(value) &&
            !(Array.isArray(value.value) && value.value.length === 0)
          )
            args[key] = value.value;
        if (mapping.target) {
          const pr = values.pr;
          if (pr === undefined || Option.isNone(pr) || typeof pr.value !== "string")
            return yield* new CliFailure({ code: 2, message: "Name the pull request." });
          Object.assign(args, yield* target(pr.value, args.host));
        }
        yield* Schema.decodeUnknownEffect(
          Schema.make<Schema.Codec<Schema.Json>>(tool.parametersSchema.ast),
        )(args).pipe(
          Effect.mapError((error) => new CliFailure({ code: 2, message: error.message })),
        );
        const result = yield* callTool(home, name, args);
        process.stdout.write(`${json ? JSON.stringify(result) : humanOutput(result)}\n`);
      }),
    ).pipe(Command.withDescription(tool.description ?? name));
  };
  const groups = new Set(
    mappings.filter(([, mapping]) => mapping.path.length > 1).map(([, mapping]) => mapping.path[0]),
  );
  const commands = [
    ...mappings
      .filter(([, mapping]) => mapping.path.length === 1)
      .map(([name, mapping]) => leaf(name, mapping)),
    ...[...groups].map((group) =>
      Command.make(group).pipe(
        Command.withSubcommands(
          mappings
            .filter(([, mapping]) => mapping.path.length > 1 && mapping.path[0] === group)
            .map(([name, mapping]) => leaf(name, mapping)),
        ),
      ),
    ),
  ];
  const usageFailure = () =>
    Effect.sync(() => {
      process.exitCode = 2;
    });
  await Effect.runPromise(
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
