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
});
export type CliInstallState = typeof CliInstallState.Type;

/** The terminal the skill installer opened in, and whether it's the user's default terminal. */
export const SkillInstallerOpened = Schema.Struct({
  terminal: Schema.String,
  isDefault: Schema.Boolean,
});
export type SkillInstallerOpened = typeof SkillInstallerOpened.Type;

export class CliInstallError extends Schema.TaggedError<CliInstallError>()("CliInstallError", {
  message: Schema.String,
}) {}
