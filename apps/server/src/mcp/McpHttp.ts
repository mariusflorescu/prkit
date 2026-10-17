import { ConflictReport, DraftGuide, FixReport, Guide, GuidePatch } from "@prkit/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpProtocol, McpServer, Tool, Toolkit } from "effect/ai";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import packageJson from "../../package.json" with { type: "json" };
import { Fixers } from "../fixers/Fixers.ts";
import { FixToolReceipt, FixToolRejected } from "../fixers/fixTools.ts";
import {
  Reviews,
  SubmitGuideReceipt,
  SubmitGuideRejected,
  ToolReceipt,
  ToolRejected,
} from "../reviews/Reviews.ts";
import { type McpCaller, McpTokens } from "./McpTokens.ts";

/**
 * Set by the auth middleware for each `/mcp` request. A reference with a default,
 * so tool registration never captures one; the request's value reaches the
 * handler through the request fiber.
 */
const CurrentCaller = Context.Reference<McpCaller | null>(
  "@prkit/server/mcp/McpHttp/CurrentCaller",
  {
    defaultValue: () => null,
  },
);

const SubmitGuide = Tool.make("submit_guide", {
  description:
    "Submit the guide for this pull request. prkit checks it against the diff: every changed file in exactly one chapter, every chapter and flow reference resolves, and every line note and every flow row's `at` lands inside a hunk of a file with a text diff. If something is wrong, the call fails with a list of problems; fix them with revise_guide, which takes only what changes. After a valid call, end your turn.",
  parameters: Guide,
  success: SubmitGuideReceipt,
  failure: SubmitGuideRejected,
})
  .annotate(Tool.Title, "Submit guide")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ReviseGuide = Tool.make("revise_guide", {
  description:
    "Fix the guide submit_guide last rejected without writing it again. Send only what changes: top-level fields you send replace the rejected ones whole (a new `flow` can also switch between a graph and rows), and each chapter you send replaces the chapter with the same id, so send it whole with its files. prkit checks the result exactly like submit_guide. After a valid call, end your turn.",
  parameters: GuidePatch,
  success: SubmitGuideReceipt,
  failure: SubmitGuideRejected,
})
  .annotate(Tool.Title, "Revise guide")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ReportProgress = Tool.make("report_progress", {
  description:
    'Tell the reviewer, in one short everyday sentence, what you are working out right now, for example "Working out where a short link is stored before this change". It replaces your previous line. Call it when your focus moves to a new part of the change, not after every step.',
  parameters: Schema.Struct({ message: Schema.String }),
  success: ToolReceipt,
  failure: ToolRejected,
})
  .annotate(Tool.Title, "Report progress")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const NoteFile = Tool.make("note_file", {
  description:
    "Once you understand what a changed file does in this pull request, give the reviewer one plain line about it, under 20 words. `path` is exactly as the diff lists it. You can send several calls at once.",
  parameters: Schema.Struct({ path: Schema.String, note: Schema.String }),
  success: ToolReceipt,
  failure: ToolRejected,
})
  .annotate(Tool.Title, "Note a file")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const SubmitDraft = Tool.make("submit_draft", {
  description:
    "Share the guide while you write it, so the reviewer can start reading. First call: the overview (summary, flow, background, steps) and every planned chapter with its id and title but no files. Then, each time you finish a chapter, call again with only that chapter (same id, now with its body and files). Fields you send replace earlier ones and chapters merge by id. prkit checks that every path, line note and reference resolves, but not yet that every file is covered. A draft never becomes the guide: finish with submit_guide.",
  parameters: DraftGuide,
  success: ToolReceipt,
  failure: ToolRejected,
})
  .annotate(Tool.Title, "Submit draft")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const FinishFixes = Tool.make("finish_fixes", {
  description:
    "Finish a batch of review comments: `summary` is the commit message (a first line under 72 characters, then optional detail), and `perComment` has one entry per comment id from the prompt with `status` fixed, partly or skipped and a one-sentence `note`. prkit checks that every comment is covered; if not, the call fails with the problems and you call again. After a valid call, end your turn: prkit commits your changes.",
  parameters: FixReport,
  success: FixToolReceipt,
  failure: FixToolRejected,
})
  .annotate(Tool.Title, "Finish fixes")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const FinishConflicts = Tool.make("finish_conflicts", {
  description:
    "Finish a merge conflict resolution: `summary` says in a sentence or two how you resolved them, and `perFile` has one entry per file the prompt asked you to resolve, with `resolution` ours (the pull request's side), theirs (the base branch's side), combined or needs-human, and a one-sentence `note`. prkit checks every file is covered and has no conflict markers left; if not, the call fails with the problems and you call again. After a valid call, end your turn.",
  parameters: ConflictReport,
  success: FixToolReceipt,
  failure: FixToolRejected,
})
  .annotate(Tool.Title, "Finish conflicts")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const PrkitToolkit = Toolkit.make(
  SubmitGuide,
  ReviseGuide,
  SubmitDraft,
  NoteFile,
  ReportProgress,
  FinishFixes,
  FinishConflicts,
);

const NO_CALLER = "This call carries no prkit attempt. End your turn.";
const NOT_A_GUIDE =
  "This tool is for writing guides, not this turn. Use the tools the prompt names.";

const layerHandlers = PrkitToolkit.toLayer(
  Effect.gen(function* () {
    const reviews = yield* Reviews;
    const fixers = yield* Fixers;
    return PrkitToolkit.of({
      submit_guide: (guide) =>
        Effect.gen(function* () {
          const caller = yield* CurrentCaller;
          if (caller === null) return yield* new SubmitGuideRejected({ message: NO_CALLER });
          if (caller._tag !== "guide")
            return yield* new SubmitGuideRejected({ message: NOT_A_GUIDE });
          return yield* reviews.submitGuide(caller.attemptId, guide);
        }),
      revise_guide: (patch) =>
        Effect.gen(function* () {
          const caller = yield* CurrentCaller;
          if (caller === null) return yield* new SubmitGuideRejected({ message: NO_CALLER });
          if (caller._tag !== "guide")
            return yield* new SubmitGuideRejected({ message: NOT_A_GUIDE });
          return yield* reviews.reviseGuide(caller.attemptId, patch);
        }),
      submit_draft: (draft) =>
        Effect.gen(function* () {
          const caller = yield* CurrentCaller;
          if (caller === null) return yield* new ToolRejected({ message: NO_CALLER });
          if (caller._tag !== "guide") return yield* new ToolRejected({ message: NOT_A_GUIDE });
          return yield* reviews.submitDraft(caller.attemptId, draft);
        }),
      note_file: ({ path, note }) =>
        Effect.gen(function* () {
          const caller = yield* CurrentCaller;
          if (caller === null) return yield* new ToolRejected({ message: NO_CALLER });
          if (caller._tag !== "guide") return yield* new ToolRejected({ message: NOT_A_GUIDE });
          return yield* reviews.noteFile(caller.attemptId, path, note);
        }),
      report_progress: ({ message }) =>
        Effect.gen(function* () {
          const caller = yield* CurrentCaller;
          if (caller === null) return yield* new ToolRejected({ message: NO_CALLER });
          if (caller._tag === "fixer")
            return yield* fixers
              .reportProgress(caller.turnId, message)
              .pipe(
                Effect.catchTag("FixToolRejected", (error) =>
                  Effect.fail(new ToolRejected({ message: error.message })),
                ),
              );
          return yield* reviews.reportProgress(caller.attemptId, message);
        }),
      finish_fixes: (report) =>
        Effect.gen(function* () {
          const caller = yield* CurrentCaller;
          if (caller?._tag !== "fixer") return yield* new FixToolRejected({ message: NO_CALLER });
          return yield* fixers.finishFixes(caller.turnId, report);
        }),
      finish_conflicts: (report) =>
        Effect.gen(function* () {
          const caller = yield* CurrentCaller;
          if (caller?._tag !== "fixer") return yield* new FixToolRejected({ message: NO_CALLER });
          return yield* fixers.finishConflicts(caller.turnId, report);
        }),
    });
  }),
);

/** Rejects requests without a live attempt token before they reach the MCP server. */
const layerAuth = HttpRouter.middleware(
  Effect.gen(function* () {
    const tokens = yield* McpTokens;
    return (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const authorization = request.headers["authorization"] ?? "";
        const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
        const caller = yield* tokens.resolve(token);
        if (caller === null) {
          yield* Effect.logWarning("Rejected /mcp request").pipe(
            Effect.annotateLogs({
              reason: token === "" ? "missing token" : "unknown or revoked token",
            }),
          );
          return HttpServerResponse.text("Unauthorized", { status: 401 });
        }
        return yield* httpEffect.pipe(Effect.provideService(CurrentCaller, caller));
      });
  }),
).layer;

const layerTransport = McpServer.layerHttp({
  name: "prkit",
  version: packageJson.version,
  path: "/mcp",
  protocols: [McpProtocol.v2025_06_18, McpProtocol.v2025_11_25],
  allowSessionTermination: true,
}).pipe(Layer.provide(layerAuth));

export const layer = McpServer.toolkit(PrkitToolkit).pipe(
  Layer.provide(layerHandlers),
  Layer.provide(layerTransport),
);
