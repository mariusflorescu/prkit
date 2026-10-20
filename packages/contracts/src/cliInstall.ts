import * as Schema from "effect/Schema";

export const CliInstallState = Schema.Struct({
  path: Schema.String,
  launcher: Schema.String,
  launcherProblem: Schema.NullOr(Schema.String),
  status: Schema.Literals(["installed", "absent", "foreign"]),
  existing: Schema.NullOr(Schema.String),
  pathSource: Schema.Literals(["process", "system", "missing"]),
  pathCommand: Schema.String,
  skillCommand: Schema.NullOr(Schema.String),
  /** Whether prkit can open the skill installer in a terminal here, which it does only on macOS. */
  opensTerminal: Schema.Boolean,
});
export type CliInstallState = typeof CliInstallState.Type;

export const SkillInstallerOpened = Schema.Struct({
  terminal: Schema.String,
  isDefault: Schema.Boolean,
});
export type SkillInstallerOpened = typeof SkillInstallerOpened.Type;

export class CliInstallError extends Schema.TaggedError<CliInstallError>()("CliInstallError", {
  message: Schema.String,
}) {}
