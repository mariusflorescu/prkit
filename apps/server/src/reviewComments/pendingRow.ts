import {
  CommentContext,
  FileSide,
  NoteKey,
  type PendingComment,
  PendingCommentState,
  ReviewCommentId,
} from "@prkit/contracts";
import * as Schema from "effect/Schema";

/** One `pending_comments` row as SQLite returns it. */
export const Row = Schema.Struct({
  id: ReviewCommentId,
  pr_key: Schema.String,
  account_id: Schema.String,
  path: Schema.String,
  start_side: FileSide,
  start_line: Schema.Int,
  end_side: FileSide,
  end_line: Schema.Int,
  snippet: Schema.String,
  context: Schema.NullOr(Schema.fromJsonString(CommentContext)),
  commit_sha: Schema.String,
  body: Schema.String,
  state: PendingCommentState,
  submission_id: Schema.NullOr(Schema.String),
  note_key: Schema.NullOr(NoteKey),
  created_at: Schema.String,
  updated_at: Schema.String,
});
export type Row = typeof Row.Type;
export const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Row));

export const anchorOf = (row: Row) => ({
  path: row.path,
  start: { side: row.start_side, line: row.start_line },
  end: { side: row.end_side, line: row.end_line },
});

export const toComment = (row: Row): PendingComment => ({
  id: row.id,
  anchor: anchorOf(row),
  snippet: row.snippet,
  context: row.context,
  commitSha: row.commit_sha,
  body: row.body,
  state: row.state,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});
