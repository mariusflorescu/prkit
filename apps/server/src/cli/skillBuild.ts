declare const PRKIT_SKILL_REPOSITORY: string;
declare const PRKIT_SKILL_REF: string;

export const skillBuild = {
  repository: typeof PRKIT_SKILL_REPOSITORY === "undefined" ? "" : PRKIT_SKILL_REPOSITORY,
  ref: typeof PRKIT_SKILL_REF === "undefined" ? "main" : PRKIT_SKILL_REF,
};
