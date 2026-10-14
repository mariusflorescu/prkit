import type { ConflictReport, FixerTurnId, FixReport } from "@prkit/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { RepoCache } from "../repo/RepoCache.ts";
import type { ConflictTurn } from "./conflictTurn.ts";
import { encodeReport } from "./fixerRows.ts";
import { clip, type FixerState, plural, reportSummary } from "./fixerState.ts";

/** What `finish_fixes`, `finish_conflicts` and `report_progress` answer a fix turn. */
export const FixToolReceipt = Schema.Struct({ message: Schema.String });
export type FixToolReceipt = typeof FixToolReceipt.Type;

/** A fix tool refused the call; the message goes back to the agent as the tool result. */
export class FixToolRejected extends Schema.TaggedError<FixToolRejected>()("FixToolRejected", {
  message: Schema.String,
}) {}

/**
 * The MCP tools a fix turn calls (docs/internals/fix-agent.md "What the agent may
 * do"): its report, checked against what was asked, and its progress line.
 */
export const makeFixTools = (state: FixerState, conflicts: ConflictTurn) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const repo = yield* RepoCache;
    const { appendActivity, awaiting, fixerById, publish, turnById } = state;
    const { markerProblems } = conflicts;

    /** The turn a tool call speaks for, if it is still the one running. */
    const liveTurn = (turnId: FixerTurnId) =>
      Effect.gen(function* () {
        const row = yield* turnById(turnId);
        const fixer = row === null ? null : yield* fixerById(row.fixer_id);
        if (row === null || fixer === null || row.status._tag !== "running")
          return yield* new FixToolRejected({
            message:
              "This turn is no longer current, so prkit ignored the call. End your turn now.",
          });
        return { row, fixer };
      });

    const toolFailures = {
      SqlError: () =>
        Effect.fail(
          new FixToolRejected({ message: "prkit couldn't save that. Call the tool again." }),
        ),
      SchemaError: () =>
        Effect.fail(
          new FixToolRejected({ message: "prkit couldn't read this turn. Call the tool again." }),
        ),
    };

    /** Problems with a report's entries against what was asked: unknown, repeated or missing. */
    const coverage = (asked: ReadonlyArray<string>, given: ReadonlyArray<string>, noun: string) => {
      const problems: Array<string> = [];
      const seen = new Set<string>();
      for (const entry of given) {
        if (!asked.includes(entry))
          problems.push(`\`${entry}\` isn't one of the ${noun}s you were given.`);
        else if (seen.has(entry)) problems.push(`\`${entry}\` is listed twice.`);
        seen.add(entry);
      }
      for (const entry of asked) if (!seen.has(entry)) problems.push(`\`${entry}\` is missing.`);
      return problems;
    };

    const rejectWith = (problems: ReadonlyArray<string>) =>
      new FixToolRejected({
        message: `The report has ${plural(problems.length, "problem")}. Fix ${problems.length === 1 ? "it" : "them"} and call the tool again:\n- ${problems.join("\n- ")}`,
      });

    const finishFixes = (turnId: FixerTurnId, report: FixReport) =>
      Effect.gen(function* () {
        const { row, fixer } = yield* liveTurn(turnId);
        if (row.work._tag !== "fix" || awaiting.get(turnId)?._tag !== "fix")
          return yield* new FixToolRejected({
            message: "This turn resolves merge conflicts. Report with finish_conflicts instead.",
          });
        const problems = coverage(
          row.work.comments.map((comment) => comment.id),
          report.perComment.map((entry) => entry.commentId),
          "comment",
        );
        if (report.summary.trim() === "")
          problems.push("`summary` is empty. Write the commit message there.");
        if (problems.length > 0) return yield* rejectWith(problems);
        const cleaned: FixReport = {
          summary: report.summary.trim().slice(0, 4000),
          perComment: report.perComment.map((entry) => ({ ...entry, note: clip(entry.note, 400) })),
        };
        yield* sql`UPDATE fixer_turns SET report = ${encodeReport(cleaned)} WHERE id = ${turnId}`;
        awaiting.delete(turnId);
        yield* appendActivity(
          fixer.pr_key,
          turnId,
          "note",
          `The agent reported: ${reportSummary(cleaned)}`,
        );
        return {
          message:
            "prkit has your report and commits the changes once you end your turn. End your turn now.",
        } satisfies FixToolReceipt;
      }).pipe(Effect.catchTags(toolFailures));

    const finishConflicts = (turnId: FixerTurnId, report: ConflictReport) =>
      Effect.gen(function* () {
        const { row, fixer } = yield* liveTurn(turnId);
        const expected = awaiting.get(turnId);
        if (row.work._tag !== "conflicts" || expected?._tag !== "conflicts")
          return yield* new FixToolRejected({
            message: "prkit isn't waiting for a conflict report from this turn. End your turn.",
          });
        const problems = coverage(
          expected.files,
          report.perFile.map((entry) => entry.path),
          "file",
        );
        if (report.summary.trim() === "")
          problems.push("`summary` is empty. Say in a sentence how you resolved them.");
        problems.push(
          ...(yield* markerProblems(
            repo.fixerPath(fixer.id),
            report.perFile
              .filter((entry) => entry.resolution !== "needs-human")
              .map((entry) => entry.path),
          )),
        );
        if (problems.length > 0) return yield* rejectWith(problems);
        const earlier = row.report !== null && "perFile" in row.report ? row.report.perFile : [];
        const merged: ConflictReport = {
          summary: report.summary.trim().slice(0, 4000),
          perFile: [
            ...earlier.filter((entry) => !expected.files.includes(entry.path)),
            ...report.perFile.map((entry) => ({ ...entry, note: clip(entry.note, 400) })),
          ],
        };
        yield* sql`UPDATE fixer_turns SET report = ${encodeReport(merged)} WHERE id = ${turnId}`;
        awaiting.delete(turnId);
        yield* appendActivity(
          fixer.pr_key,
          turnId,
          "note",
          `The agent resolved ${plural(report.perFile.length, "file")}`,
        );
        return {
          message:
            "prkit checked the files and commits the resolution once you end your turn. End your turn now.",
        } satisfies FixToolReceipt;
      }).pipe(Effect.catchTags(toolFailures));

    const reportProgress = (turnId: FixerTurnId, message: string) =>
      Effect.gen(function* () {
        const { fixer } = yield* liveTurn(turnId);
        const line = clip(message, 160);
        if (line === "")
          return yield* new FixToolRejected({
            message: "Send one short line about what you are doing.",
          });
        yield* sql`UPDATE fixer_turns SET narration = ${line} WHERE id = ${turnId}`;
        yield* publish(fixer.pr_key);
        return { message: "The owner sees it. Keep going." } satisfies FixToolReceipt;
      }).pipe(Effect.catchTags(toolFailures));

    return { finishFixes, finishConflicts, reportProgress };
  });
