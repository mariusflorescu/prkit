import { capture, diffRows, type PullRequestFiles } from "@prkit/contracts";
import * as Effect from "effect/Effect";

import { fail } from "./errors.ts";

/** Lines an outside agent names on a pull request's diff. */
export type LinesInput = {
  readonly path: string;
  readonly line: number;
  readonly startLine?: number;
  readonly side?: "new" | "old";
  readonly headSha: string;
};

/** The lines as a placement on GitHub's diff of the PR now, or why a comment can't go there. */
export const placementOn = (files: PullRequestFiles, input: LinesInput) =>
  Effect.gen(function* () {
    if (files.headSha !== input.headSha)
      return yield* fail(
        "conflict",
        `This pull request moved to ${files.headSha.slice(0, 12)} since ${input.headSha.slice(0, 12)}. Read it again and name the lines on its new head.`,
      );
    const file = files.files.find((entry) => entry.path === input.path);
    if (file === undefined)
      return yield* fail("invalid", `${input.path} isn't among this pull request's changed files.`);
    if (file.patch._tag !== "text")
      return yield* fail("invalid", `${input.path} has no text diff to comment on.`);
    const side = input.side ?? "new";
    const placement = capture(
      diffRows(file.patch.patch),
      {
        path: input.path,
        start: { side, line: input.startLine ?? input.line },
        end: { side, line: input.line },
      },
      files.headSha,
    );
    if (placement === null)
      return yield* fail(
        "invalid",
        `Lines ${input.startLine ?? input.line}-${input.line} on the ${side} side of ${input.path} aren't inside one hunk of the diff. GitHub takes comments only there.`,
      );
    return placement;
  });
