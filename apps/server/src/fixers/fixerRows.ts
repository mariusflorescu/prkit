import {
  AccountId,
  AgentInstanceId,
  AgentProviderKind,
  ConflictedFile,
  ConflictReport,
  ConflictStrategy,
  type Fixer,
  FixComment,
  FixerActivity,
  FixerDiff,
  FixerId,
  FixerTrigger,
  type FixerTurn,
  FixerTurnId,
  FixerTurnStatus,
  type FixerWork,
  FixReport,
  ModelOptionSelection,
  PullRequestKey,
  TurnScripts,
} from "@prkit/contracts";
import * as Schema from "effect/Schema";

import { decodeEach, decodeReadable } from "../persistence/damagedRows.ts";

/** What a turn was asked to do, as stored; what came back lives in its own columns. */
export const WorkRequest = Schema.Union([
  Schema.TaggedStruct("fix", {
    comments: Schema.NonEmptyArray(FixComment),
    note: Schema.NullOr(Schema.String),
    replyAfterPush: Schema.Boolean,
  }),
  Schema.TaggedStruct("conflicts", { strategy: ConflictStrategy }),
  Schema.TaggedStruct("revert", { turnId: FixerTurnId, sha: Schema.String }),
]);
export type WorkRequest = typeof WorkRequest.Type;

const Report = Schema.Union([FixReport, ConflictReport]);

export const FixerRow = Schema.Struct({
  id: FixerId,
  pr_key: PullRequestKey,
  account_id: AccountId,
  provider: AgentProviderKind,
  instance_id: AgentInstanceId,
  model: Schema.NullOr(Schema.String),
  model_options: Schema.fromJsonString(Schema.Array(ModelOptionSelection)),
  session_id: Schema.NullOr(Schema.String),
  ended: Schema.NullOr(Schema.Literals(["merged", "closed", "stopped"])),
  created_at: Schema.String,
  updated_at: Schema.String,
});
export type FixerRow = typeof FixerRow.Type;

/** Every turn column but the diff, which only the Fixes panel's diff view reads. */
export const TURN_COLUMNS =
  "id, fixer_id, work, trigger, status, provider, instance_id, model, run_id, agent_pid, agent_started, head_sha, base_sha, head_ref, base_ref, head_repo, commit_sha, commit_parents, commit_message, report, conflicted, scripts, narration, rounds, started_by, created_at, started_at, finished_at";

export const TurnRow = Schema.Struct({
  id: FixerTurnId,
  fixer_id: FixerId,
  work: Schema.fromJsonString(WorkRequest),
  trigger: FixerTrigger,
  status: Schema.fromJsonString(FixerTurnStatus),
  provider: AgentProviderKind,
  instance_id: AgentInstanceId,
  model: Schema.NullOr(Schema.String),
  run_id: Schema.NullOr(Schema.String),
  agent_pid: Schema.NullOr(Schema.Int),
  agent_started: Schema.NullOr(Schema.String),
  head_sha: Schema.NullOr(Schema.String),
  base_sha: Schema.NullOr(Schema.String),
  head_ref: Schema.NullOr(Schema.String),
  base_ref: Schema.NullOr(Schema.String),
  head_repo: Schema.NullOr(Schema.String),
  commit_sha: Schema.NullOr(Schema.String),
  commit_parents: Schema.NullOr(Schema.fromJsonString(Schema.Array(Schema.String))),
  commit_message: Schema.NullOr(Schema.String),
  report: Schema.NullOr(Schema.fromJsonString(Report)),
  conflicted: Schema.fromJsonString(Schema.Array(ConflictedFile)),
  scripts: Schema.NullOr(Schema.fromJsonString(TurnScripts)),
  narration: Schema.NullOr(Schema.String),
  rounds: Schema.Int,
  started_by: Schema.NullOr(Schema.String),
  created_at: Schema.String,
  started_at: Schema.NullOr(Schema.String),
  finished_at: Schema.NullOr(Schema.String),
});
export type TurnRow = typeof TurnRow.Type;

export const ActivityRow = Schema.Struct({
  id: Schema.Int,
  turn_id: FixerTurnId,
  at: Schema.String,
  kind: FixerActivity.fields.kind,
  text: Schema.String,
  detail: Schema.NullOr(Schema.String),
});

export const decodeFixers = Schema.decodeUnknownEffect(Schema.Array(FixerRow));
export const decodeTurns = Schema.decodeUnknownEffect(Schema.Array(TurnRow));
/** Lists read every row they can and leave a damaged one out (logged), so it fails alone. */
export const readableFixers = decodeReadable("fixers", FixerRow);
export const readableTurns = decodeReadable("fixer_turns", TurnRow);
export const decodeEachFixer = decodeEach("fixers", FixerRow);
/** Each turn's state on its own, so startup can leave one it can't read as it was. */
export const decodeTurnStates = decodeEach(
  "fixer_turns",
  Schema.Struct({ id: FixerTurnId, status: Schema.fromJsonString(FixerTurnStatus) }),
);
export const decodeActivity = Schema.decodeUnknownEffect(Schema.Array(ActivityRow));
export const decodeDiff = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ diff: Schema.NullOr(Schema.fromJsonString(FixerDiff)) })),
);
export const encodeWork = Schema.encodeSync(Schema.fromJsonString(WorkRequest));
export const encodeStatus = Schema.encodeSync(Schema.fromJsonString(FixerTurnStatus));
export const encodeReport = Schema.encodeSync(Schema.fromJsonString(Report));
export const encodeConflicted = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(ConflictedFile)),
);
export const encodeDiff = Schema.encodeSync(Schema.fromJsonString(FixerDiff));
export const encodeParents = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
export const encodeOptions = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(ModelOptionSelection)),
);

export const toFixer = (row: FixerRow): Fixer => ({
  id: row.id,
  key: row.pr_key,
  accountId: row.account_id,
  provider: row.provider,
  instance: row.instance_id,
  model: row.model,
  modelOptions: row.model_options,
  sessionId: row.session_id,
  status: row.ended === null ? { _tag: "active" } : { _tag: "done", reason: row.ended },
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const workOf = (row: TurnRow): FixerWork => {
  const { work, report } = row;
  switch (work._tag) {
    case "fix":
      return {
        ...work,
        report: report !== null && "perComment" in report ? report : null,
      };
    case "conflicts":
      return {
        _tag: "conflicts",
        strategy: work.strategy,
        conflicted: row.conflicted,
        report: report !== null && "perFile" in report ? report : null,
      };
    case "revert":
      return work;
  }
};

export const toTurn = (row: TurnRow): FixerTurn => ({
  id: row.id,
  work: workOf(row),
  trigger: row.trigger,
  status: row.status,
  provider: row.provider,
  instance: row.instance_id,
  model: row.model,
  headSha: row.head_sha,
  baseSha: row.base_sha,
  headRef: row.head_ref,
  baseRef: row.base_ref,
  commit:
    row.commit_sha === null
      ? null
      : {
          sha: row.commit_sha,
          parents: row.commit_parents ?? [],
          message: row.commit_message ?? "",
        },
  scripts: row.scripts,
  narration: row.narration,
  rounds: row.rounds,
  startedBy: row.started_by,
  createdAt: row.created_at,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
});

export const toActivity = (row: typeof ActivityRow.Type): FixerActivity => ({
  id: row.id,
  turnId: row.turn_id,
  at: row.at,
  kind: row.kind,
  text: row.text,
  detail: row.detail,
});
