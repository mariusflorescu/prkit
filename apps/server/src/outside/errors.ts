import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { OutsideToolFailure } from "./schemas.ts";

const PLAIN_ERRORS: Record<string, OutsideToolFailure["code"]> = {
  ReviewError: "failed",
  ReviewStateError: "conflict",
  GuideNotFoundError: "not-found",
  PullRequestReadError: "github",
  PullRequestActionError: "github",
  InboxError: "github",
  AccountsError: "failed",
  WorkspaceError: "conflict",
  ReviewCommentsError: "failed",
  ReviewedFilesError: "failed",
  FixerError: "failed",
  FixerStateError: "conflict",
  FixerWorkRefused: "not-allowed",
  RepositoryError: "github",
  GuideConfigError: "invalid",
  GuideConfigConflict: "conflict",
  GuideSettingsError: "failed",
  AppearanceSettingsError: "failed",
  OutsideAgentsError: "failed",
};

/** Only service errors written for the user cross the outside boundary. */
export const asFailure = (error: { readonly _tag: string; readonly message: string }) => {
  if (Schema.is(OutsideToolFailure)(error)) return error;
  const code = PLAIN_ERRORS[error._tag];
  return new OutsideToolFailure(
    code === undefined
      ? { code: "failed", message: "prkit couldn't do that. Try again." }
      : { code, message: error.message },
  );
};

export const fail = (code: OutsideToolFailure["code"], message: string) =>
  Effect.fail(new OutsideToolFailure({ code, message }));
