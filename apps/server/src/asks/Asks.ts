import {
  AgentInstanceId,
  AgentProviderKind,
  type AnswerAgent,
  AnswerBasis,
  AnswerPart,
  answerText,
  AskError,
  AskFailure,
  type AskInput,
  askedChapter,
  askedRows,
  AskScope,
  type AskWatchEvent,
  findAgentModel,
  type LocalReviewKey,
  NormalizedGuide,
  type Question,
  QuestionId,
  type QuestionState,
  resolveModelOptions,
  ReviewId,
} from "@prkit/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpServer } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import * as SqlClient from "effect/sql/SqlClient";

import {
  type AgentError,
  type AgentEvent,
  type AgentProvider,
  ASK_TOOLS,
  type TurnSetup,
} from "../agents/AgentProvider.ts";
import { processStartTime, reapAgentGroup } from "../agents/agentProcess.ts";
import { Agents } from "../agents/Agents.ts";
import { turnTmpDir } from "../agents/commandReach.ts";
import * as ServerConfig from "../config.ts";
import { makeKeyedGate } from "../github/keyedGate.ts";
import { boundPort } from "../listenAddress.ts";
import { McpTokens } from "../mcp/McpTokens.ts";
import { StartedBy } from "../outside/StartedBy.ts";
import { decodeEach, logDamaged } from "../persistence/damagedRows.ts";
import { type Checkout, RepoCache } from "../repo/RepoCache.ts";
import { numberedDiff } from "../reviews/prompt.ts";
import { type RevisionContext, Reviews } from "../reviews/Reviews.ts";
import { catchUp, foldAnswer } from "./answer.ts";
import { forkSources } from "./plan.ts";
import { askPrompt, EARLIER_ANSWERS } from "./prompt.ts";
import { SUBJECTS, subjectOf } from "./subject.ts";

/** Why an answer ended without one: the question's `failed` state. */
class AnswerFailure extends Schema.TaggedError<AnswerFailure>()("AnswerFailure", {
  reason: AskFailure,
  message: Schema.String,
}) {}

const Common = {
  id: QuestionId,
  review_id: ReviewId,
  revision: Schema.Int,
  scope: Schema.fromJsonString(AskScope),
  text: Schema.String,
  asked_by: Schema.NullOr(Schema.String),
  asked_at: Schema.String,
  answer: Schema.fromJsonString(Schema.Array(AnswerPart)),
  pinned_at: Schema.NullOr(Schema.String),
};
const Answering = {
  instance_id: AgentInstanceId,
  provider: AgentProviderKind,
  basis: Schema.fromJsonString(AnswerBasis),
};
/** A row as each state stores it; one that doesn't fit its state reads as damaged. */
const QuestionRow = Schema.Union([
  Schema.Struct({ ...Common, state: Schema.Literal("starting") }),
  Schema.Struct({ ...Common, state: Schema.Literal("waiting") }),
  Schema.Struct({ ...Common, state: Schema.Literal("answering"), ...Answering }),
  Schema.Struct({
    ...Common,
    state: Schema.Literal("answered"),
    ...Answering,
    finished_at: Schema.String,
  }),
  Schema.Struct({
    ...Common,
    state: Schema.Literal("stopped"),
    instance_id: Schema.NullOr(AgentInstanceId),
    provider: Schema.NullOr(AgentProviderKind),
    basis: Schema.NullOr(Schema.fromJsonString(AnswerBasis)),
    finished_at: Schema.String,
  }),
  Schema.Struct({
    ...Common,
    state: Schema.Literal("failed"),
    failure: AskFailure,
    message: Schema.String,
    finished_at: Schema.String,
  }),
]);
type QuestionRow = typeof QuestionRow.Type;

const decodeQuestions = Schema.decodeUnknownEffect(Schema.Array(QuestionRow));
/** A review's questions read every one they can, and leave a damaged one out (logged and named). */
const decodeEachQuestion = decodeEach("ask_questions", QuestionRow);
const decodeIds = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ id: QuestionId })));
/** Each unfinished question on its own: one whose agent can't be read still fails as interrupted. */
const decodeStale = decodeEach(
  "ask_questions",
  Schema.Struct({
    id: QuestionId,
    agent_pid: Schema.NullOr(Schema.Int),
    agent_started: Schema.NullOr(Schema.String),
  }),
);
const decodePrevious = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({ id: QuestionId, session_id: Schema.String, instance_id: AgentInstanceId }),
  ),
);
const decodeAnswered = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      text: Schema.String,
      answer: Schema.fromJsonString(Schema.Array(AnswerPart)),
    }),
  ),
);
const encodeScope = Schema.encodeSync(Schema.fromJsonString(AskScope));
const encodeBasis = Schema.encodeSync(Schema.fromJsonString(AnswerBasis));
const encodeAnswer = Schema.encodeSync(Schema.fromJsonString(Schema.Array(AnswerPart)));
/** The guide as the agent reads it: indented, so no line is too long to read. */
const encodeReadableGuide = Schema.encodeSync(Schema.fromJsonString(NormalizedGuide, { space: 2 }));

const ACTIVE = ["starting", "waiting", "answering"] as const;
/** Where a question may move from, by the state it moves to (contracts' `QuestionState`). */
const ALLOWED_FROM = {
  waiting: ["starting"],
  answering: ["starting", "waiting"],
  answered: ["answering"],
  stopped: ACTIVE,
  failed: ACTIVE,
  starting: ["stopped", "failed"],
} as const;
/** A stuck answer gives its agent slot back to guides and fixes after this. */
const TURN_LIMIT = "10 minutes";
/** How often watchers are sent what an answer gained: about 20 times a second. */
const FLUSH_EVERY = "50 millis";
const AGENT_OFF =
  "This guide's agent is turned off or was removed. Turn it on in Settings > Agents, then retry.";
const INTERRUPTED = "prkit closed before this answer finished. Ask again.";
const BUSY = "Wait for this answer or stop it to ask another.";

const stateOf = (row: QuestionRow): QuestionState => {
  switch (row.state) {
    case "starting":
      return { _tag: "starting" };
    case "waiting":
      return { _tag: "waiting" };
    case "answering":
      return {
        _tag: "answering",
        agent: { instance: row.instance_id, kind: row.provider },
        basis: row.basis,
      };
    case "answered":
      return {
        _tag: "answered",
        agent: { instance: row.instance_id, kind: row.provider },
        basis: row.basis,
        finishedAt: row.finished_at,
      };
    case "stopped":
      return {
        _tag: "stopped",
        agent:
          row.instance_id === null || row.provider === null
            ? null
            : { instance: row.instance_id, kind: row.provider },
        basis: row.basis,
        finishedAt: row.finished_at,
      };
    case "failed":
      return {
        _tag: "failed",
        reason: row.failure,
        message: row.message,
        finishedAt: row.finished_at,
      };
  }
};

/** A state a question moves to, with what it needs; retry moves it back in `retry` itself. */
type Move =
  | { readonly _tag: "waiting" }
  | { readonly _tag: "answering"; readonly agent: AnswerAgent; readonly basis: AnswerBasis }
  | { readonly _tag: "answered" }
  | { readonly _tag: "stopped" }
  | { readonly _tag: "failed"; readonly reason: AskFailure; readonly message: string };

/** Where a question's turn runs: its revision's checkout, and the folder of files it reads. */
interface Place {
  readonly checkout: Checkout;
  readonly contextDir: string;
  readonly diffFile: string;
  readonly guideFile: string;
}

/**
 * One run of a question's answer: whether the user stopped it, its parts so far, and how much
 * of each part watchers were sent. Each run has its own, so a retry never shares one.
 */
interface Live {
  readonly reviewId: ReviewId;
  stopped: boolean;
  parts: ReadonlyArray<AnswerPart>;
  sent: ReadonlyArray<number>;
}

/**
 * Questions about a pull request's guide (docs/features/outside-agents.md lists its RPCs).
 * Each one is answered by the review's agent in a fork of the guide's conversation, or of the
 * answer before it on the same revision, never by resuming either in place.
 */
export class Asks extends Context.Service<Asks, Effect.Success<typeof make>>()(
  "@prkit/server/asks/Asks",
) {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const reviews = yield* Reviews;
  const agents = yield* Agents;
  const tokens = yield* McpTokens;
  const repo = yield* RepoCache;
  const server = yield* HttpServer.HttpServer;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scope = yield* Effect.scope;

  const mcpUrl = `http://${config.host}:${Option.getOrElse(boundPort(server.address), () => config.port)}/mcp`;
  const instructions = yield* fs.readFileString(
    path.join(
      path.dirname(yield* path.fromFileUrl(new URL(import.meta.url))),
      "ask-instructions.md",
    ),
  );
  /** Checkouts and the files answers read, a cache that every start clears. */
  const asksDir = path.join(config.home, "asks");
  /** Names this server run; startup fails only questions earlier runs left unfinished. */
  const runId = yield* crypto.randomUUIDv4;
  const changes = yield* PubSub.unbounded<{
    readonly reviewId: ReviewId;
    readonly event: AskWatchEvent;
  }>();
  const running = new Map<QuestionId, { readonly live: Live; readonly fiber: Fiber.Fiber<void> }>();
  /**
   * Asking, retrying and removing a local review take turns per review, so no question starts
   * while a removal stops the review's answers and deletes them.
   */
  const lifecycle = makeKeyedGate<ReviewId>(1);

  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  // The OS random source failing is not something a question can recover from.
  const newId = crypto.randomUUIDv4.pipe(Effect.orDie);
  const refuse = (reason: AskError["reason"], message: string) =>
    Effect.fail(new AskError({ reason, message }));
  const storeFailures = {
    SqlError: () => refuse("failed", "prkit couldn't read or save the question."),
    SchemaError: () => refuse("failed", "prkit read a damaged question record."),
  };
  const toQuestion = (row: QuestionRow): Question => ({
    id: row.id,
    reviewId: row.review_id,
    revision: row.revision,
    scope: row.scope,
    text: row.text,
    askedBy: row.asked_by,
    askedAt: row.asked_at,
    state: stateOf(row),
    // Only the run that moved its row to answering has parts for it; the rest are stored.
    answer: (row.state === "answering" ? running.get(row.id)?.live.parts : undefined) ?? row.answer,
    pinnedAt: row.pinned_at,
  });
  const publish = (question: Question) =>
    PubSub.publish(changes, {
      reviewId: question.reviewId,
      event: { _tag: "question", question },
    }).pipe(Effect.asVoid);

  const find = (id: QuestionId) =>
    sql`SELECT * FROM ask_questions WHERE id = ${id}`.pipe(
      Effect.flatMap(decodeQuestions),
      Effect.map((rows) => (rows[0] === undefined ? null : toQuestion(rows[0]))),
    );
  /** The review's questions, oldest first, and the ones prkit couldn't read. */
  const questionsOf = (reviewId: ReviewId) =>
    sql`SELECT * FROM ask_questions WHERE review_id = ${reviewId} ORDER BY asked_at, rowid`.pipe(
      Effect.flatMap(decodeEachQuestion),
      Effect.tap(([, damaged]) => Effect.forEach(damaged, logDamaged, { discard: true })),
      Effect.map(([rows, damaged]) => ({
        _tag: "snapshot" as const,
        questions: rows.map(toQuestion),
        damaged: damaged.flatMap((row) => (row.id === null ? [] : [row.id])),
      })),
    );
  /** Refuses a question because another on the review is still being answered, naming that one. */
  const refuseBusy = (reviewId: ReviewId) =>
    sql`SELECT id FROM ask_questions WHERE review_id = ${reviewId}
      AND state IN ${sql.in(ACTIVE)}`.pipe(
      Effect.flatMap(decodeIds),
      Effect.flatMap((rows) =>
        Effect.fail(
          new AskError({
            reason: "busy",
            message: BUSY,
            ...(rows[0] === undefined ? {} : { active: rows[0].id }),
          }),
        ),
      ),
    );

  /** The update that moves a question to `to`, only from a state `ALLOWED_FROM` allows. */
  const update = (
    id: QuestionId,
    to: Move,
    at: string,
    parts: ReadonlyArray<AnswerPart> | null,
  ) => {
    const from = sql.in(ALLOWED_FROM[to._tag]);
    const answer = parts === null ? null : encodeAnswer(parts);
    switch (to._tag) {
      case "waiting":
        return sql`UPDATE ask_questions SET state = 'waiting'
          WHERE id = ${id} AND state IN ${from} RETURNING *`;
      case "answering":
        return sql`UPDATE ask_questions SET state = 'answering',
            instance_id = ${to.agent.instance}, provider = ${to.agent.kind},
            basis = ${encodeBasis(to.basis)}
          WHERE id = ${id} AND state IN ${from} RETURNING *`;
      case "answered":
        return sql`UPDATE ask_questions SET state = 'answered',
            answer = COALESCE(${answer}, answer), finished_at = ${at}
          WHERE id = ${id} AND state IN ${from} RETURNING *`;
      case "stopped":
        return sql`UPDATE ask_questions SET state = 'stopped',
            answer = COALESCE(${answer}, answer), finished_at = ${at}
          WHERE id = ${id} AND state IN ${from} RETURNING *`;
      case "failed":
        return sql`UPDATE ask_questions SET state = 'failed', failure = ${to.reason},
            message = ${to.message}, answer = COALESCE(${answer}, answer), finished_at = ${at}
          WHERE id = ${id} AND state IN ${from} RETURNING *`;
    }
  };
  /**
   * Moves a question on and tells watchers, keeping `parts` as its answer when given. False
   * when it had already moved on, so a late or repeated move changes nothing.
   */
  const move = (id: QuestionId, to: Move, parts: ReadonlyArray<AnswerPart> | null) =>
    Effect.gen(function* () {
      const rows = yield* update(id, to, yield* now, parts).pipe(Effect.flatMap(decodeQuestions));
      const row = rows[0];
      if (row === undefined) return false;
      yield* publish(toQuestion(row));
      return true;
    });

  /** Sends watchers what the answer gained since they were last sent it. */
  const flush = (id: QuestionId, live: Live) =>
    Effect.suspend(() => {
      const { events, sent } = catchUp(id, live.parts, live.sent);
      live.sent = sent;
      return Effect.forEach(
        events,
        (event) => PubSub.publish(changes, { reviewId: live.reviewId, event }),
        { discard: true },
      );
    });

  const foldersOf = ({ reviewId, revision }: Pick<Question, "reviewId" | "revision">) => {
    // git names a checkout's git dir after its folder, so the name is unique per repository.
    const name = `${reviewId}-r${revision}`;
    return {
      checkoutDir: path.join(asksDir, "checkouts", name),
      contextDir: path.join(asksDir, "context", name),
    };
  };

  /** The revision's checkout and the files its answers read, made again for each question. */
  const prepare = (context: RevisionContext) =>
    Effect.gen(function* () {
      const { checkoutDir, contextDir } = foldersOf(context);
      yield* fs.makeDirectory(path.dirname(checkoutDir), { recursive: true });
      const checkout = yield* context.checkout(checkoutDir);
      yield* fs.makeDirectory(contextDir, { recursive: true });
      const place: Place = {
        checkout,
        contextDir,
        diffFile: path.join(contextDir, SUBJECTS[subjectOf(context.key)].diffFile),
        guideFile: path.join(contextDir, "guide.json"),
      };
      yield* fs.writeFileString(place.diffFile, numberedDiff(context.snapshot).text);
      yield* fs.writeFileString(place.guideFile, encodeReadableGuide(context.guide));
      return place;
    });

  /** The newest answer on the revision whose conversation `group` can fork, for a follow-up. */
  const previousOf = (question: Question, group: ReadonlyArray<AgentInstanceId>) =>
    sql`SELECT id, session_id, instance_id FROM ask_questions
      WHERE review_id = ${question.reviewId} AND revision = ${question.revision} AND id != ${question.id}
        AND state = 'answered' AND session_id IS NOT NULL AND instance_id IN ${sql.in(group)}
      ORDER BY finished_at DESC, rowid DESC LIMIT 1`.pipe(
      Effect.flatMap(decodePrevious),
      Effect.map((rows) =>
        rows[0] === undefined
          ? null
          : { id: rows[0].id, sessionId: rows[0].session_id, instance: rows[0].instance_id },
      ),
    );
  /** The latest answered questions on the revision, oldest first, for a new conversation. */
  const answeredBefore = (question: Question) =>
    sql`SELECT text, answer FROM ask_questions
      WHERE review_id = ${question.reviewId} AND revision = ${question.revision} AND id != ${question.id}
        AND state = 'answered'
      ORDER BY finished_at DESC, rowid DESC LIMIT ${EARLIER_ANSWERS}`.pipe(
      Effect.flatMap(decodeAnswered),
      Effect.map((rows) =>
        rows.map((row) => ({ question: row.text, answer: answerText(row.answer) })).toReversed(),
      ),
    );

  /** What one agent event does to the answer and its row. */
  const record = (
    id: QuestionId,
    live: Live,
    event: AgentEvent,
    finished: { outcome: string | null; message: string | null },
  ) => {
    switch (event._tag) {
      case "process":
        return processStartTime(event.pid).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.flatMap(
            (started) => sql`UPDATE ask_questions SET agent_pid = ${event.pid},
              agent_started = ${started} WHERE id = ${id}`,
          ),
          Effect.asVoid,
        );
      case "session":
        // The answer's own conversation, a fork or a new one. The guide's is never written.
        return sql`UPDATE ask_questions SET session_id = ${event.sessionId} WHERE id = ${id}`.pipe(
          Effect.asVoid,
        );
      case "text":
      case "tool":
        return Effect.sync(() => {
          live.parts = foldAnswer(
            live.parts,
            event._tag === "text"
              ? { _tag: "text", delta: event.delta }
              : { _tag: "tool", label: event.label },
          );
        });
      case "finished":
        return Effect.sync(() => {
          finished.outcome = event.outcome;
          finished.message = event.message;
        });
      case "tool-done":
      case "mcp-ready":
      case "composing-guide":
      case "guide-input":
        return Effect.void;
    }
  };

  /** The agent's turn: the events it reports, folded into the answer and sent on about 20 times a second. */
  const runTurn = (id: QuestionId, live: Live, stream: Stream.Stream<AgentEvent, AgentError>) =>
    Effect.gen(function* () {
      const finished: { outcome: string | null; message: string | null } = {
        outcome: null,
        message: null,
      };
      yield* stream.pipe(
        Stream.tap((event) => record(id, live, event, finished)),
        Stream.groupedWithin(10_000, FLUSH_EVERY),
        Stream.runForEach(() => flush(id, live)),
      );
      return finished;
    });

  /** The question's revision as it stands now. */
  const contextOf = (question: Question) =>
    reviews.revisionContext(question.reviewId, question.revision).pipe(
      Effect.filterOrFail(
        (context) => context !== null,
        () =>
          new AnswerFailure({
            reason: "not-ready",
            message: "This guide revision is gone, so the question can't be answered.",
          }),
      ),
    );

  /** Inside an agent slot: picks the conversation to fork, runs the agent, and keeps its answer. */
  const answerIn = (question: Question, live: Live, place: Place) =>
    Effect.gen(function* () {
      // Read again inside the slot: a guide update may have run while the question waited and
      // moved the guide's session past this revision.
      const context = yield* contextOf(question);
      const instance = yield* agents.usable(context.agent.instance, context.agent.kind);
      const provider: AgentProvider | null = instance === null ? null : yield* agents.get(instance);
      if (provider === null)
        return yield* new AnswerFailure({ reason: "not-ready", message: AGENT_OFF });
      const group = yield* agents.sameGroup(provider.instance);
      const plan = forkSources({
        canFork: provider.forkTurn !== null,
        group: new Set(group),
        writer: context.writer,
        previous: yield* previousOf(question, group),
        checkout: place.checkout.worktree,
      });
      // Asked inside the slot: Codex's and Cursor's lookups start an agent process.
      const source = yield* Effect.findFirst(plan.sources, (candidate) =>
        provider.hasSession(candidate.sessionId, candidate.cwd),
      );
      const basis: AnswerBasis = Option.isSome(source)
        ? source.value.basis
        : { _tag: "fresh", why: plan.otherwise };
      const agent = { instance: provider.instance, kind: provider.kind };
      if (!(yield* move(question.id, { _tag: "answering", agent, basis }, null))) return;
      yield* Effect.logInfo("Answering a question").pipe(
        Effect.annotateLogs({ instance: provider.instance, basis: basis._tag }),
      );

      const tmpDir = turnTmpDir(path, question.id);
      yield* Effect.acquireRelease(
        fs
          .remove(tmpDir, { recursive: true, force: true })
          .pipe(Effect.andThen(fs.makeDirectory(tmpDir, { mode: 0o700 }))),
        () => fs.remove(tmpDir, { recursive: true, force: true }).pipe(Effect.ignore),
      );
      const token = yield* tokens.issue({
        _tag: "ask",
        questionId: question.id,
        reviewId: question.reviewId,
      });
      // Every setting the model takes goes in explicitly, as a guide's turn does.
      const model = findAgentModel(yield* agents.catalog(), provider.instance, context.agent.model);
      const options =
        model === undefined
          ? context.agent.options
          : resolveModelOptions(model.options, context.agent.options).map((option) => ({
              id: option.descriptor.id,
              value: option.value,
            }));
      const input: TurnSetup = {
        turn: { id: question.id, ended: () => Effect.void },
        cwd: place.checkout.worktree,
        checkout: place.checkout,
        readableDirs: [place.contextDir],
        instructions,
        prompt: askPrompt({
          subject: subjectOf(context.key),
          label: context.label,
          revision: context.revision,
          headSha: context.headSha,
          guide: context.guide,
          snapshot: context.snapshot,
          cwd: place.checkout.worktree,
          diffFile: place.diffFile,
          guideFile: place.guideFile,
          basis,
          scope: question.scope,
          question: question.text,
          earlier: basis._tag === "fresh" ? yield* answeredBefore(question) : [],
        }),
        model: context.agent.model,
        options,
        mcp: { url: mcpUrl, bearerToken: Redacted.value(token) },
        env: repo.isolatedGitEnv,
        access: { _tag: "read-only", tmpDir },
        tools: ASK_TOOLS,
      };
      const finished = yield* runTurn(
        question.id,
        live,
        Option.isSome(source) && provider.forkTurn !== null
          ? provider.forkTurn({ ...input, forkFrom: source.value.sessionId })
          : provider.runTurn({ ...input, resumeSessionId: null }),
      ).pipe(
        Effect.timeoutOrElse({
          duration: TURN_LIMIT,
          orElse: () =>
            Effect.fail(
              new AnswerFailure({
                reason: "timeout",
                message: `${provider.label} took more than 10 minutes to answer, so prkit stopped it. Retry, or ask a narrower question.`,
              }),
            ),
        }),
        Effect.catchTag("AgentError", (error) =>
          (error.reason === "auth" ? agents.invalidate : Effect.void).pipe(
            Effect.andThen(
              Effect.fail(
                new AnswerFailure({
                  reason: error.reason === "auth" ? "agent-auth" : "agent",
                  message: error.message,
                }),
              ),
            ),
          ),
        ),
      );
      if (finished.outcome !== "completed")
        return yield* new AnswerFailure({
          reason: "agent",
          message: finished.message ?? `${provider.label} stopped before it answered.`,
        });
      if (answerText(live.parts) === "")
        return yield* new AnswerFailure({
          reason: "empty",
          message: `${provider.label} finished without writing an answer. Retry, or ask another way.`,
        });
      yield* move(question.id, { _tag: "answered" }, live.parts);
    }).pipe(Effect.scoped);

  /** Everything from a stored question to its answer: its code, then an agent slot, then the turn. */
  const answer = (question: Question, live: Live) => {
    const saveFailed = Effect.suspend(() =>
      move(
        question.id,
        { _tag: "failed", reason: "agent", message: "prkit couldn't save this answer." },
        live.parts,
      ).pipe(Effect.ignore),
    );
    return Effect.gen(function* () {
      // Before the slot: preparing the code needs git, not an agent.
      const place = yield* prepare(yield* contextOf(question));
      const body = answerIn(question, live, place);
      const ran = yield* agents.slots.withPermitsIfAvailable(1)(body);
      if (Option.isSome(ran)) return;
      if (yield* move(question.id, { _tag: "waiting" }, null))
        yield* agents.slots.withPermits(1)(body);
    }).pipe(
      Effect.catchTags({
        ReviewError: (error) =>
          Effect.fail(new AnswerFailure({ reason: "agent", message: error.message })),
        RepoError: (error) =>
          Effect.fail(new AnswerFailure({ reason: "repository", message: error.message })),
        PlatformError: () =>
          Effect.fail(
            new AnswerFailure({
              reason: "repository",
              message:
                "prkit couldn't write the question's files. Check the disk has space, then retry.",
            }),
          ),
      }),
      Effect.catchTag("AnswerFailure", (failure) =>
        move(
          question.id,
          { _tag: "failed", reason: failure.reason, message: failure.message },
          live.parts,
        ),
      ),
      Effect.catchTags({
        SqlError: (error) =>
          Effect.logError("Couldn't record the question's outcome", error).pipe(
            Effect.andThen(saveFailed),
          ),
        SchemaError: (error) =>
          Effect.logError("Couldn't record the question's outcome", error).pipe(
            Effect.andThen(saveFailed),
          ),
      }),
      Effect.tapDefect((defect) =>
        Effect.logError("Answering a question crashed", defect).pipe(
          Effect.andThen(
            move(
              question.id,
              { _tag: "failed", reason: "agent", message: "prkit hit an internal error." },
              live.parts,
            ),
          ),
          Effect.ignore,
        ),
      ),
      Effect.asVoid,
      Effect.annotateLogs({ questionId: question.id, reviewId: question.reviewId }),
    );
  };

  /**
   * Answers the question in the service's scope. A stop interrupts the fiber, which stops its
   * agent and moves the question to stopped itself.
   */
  const launch = (question: Question) =>
    Effect.gen(function* () {
      const live: Live = { reviewId: question.reviewId, stopped: false, parts: [], sent: [] };
      const registered = yield* Deferred.make<void>();
      const previous = [...running.values()].filter(
        (run) => run.live.reviewId === question.reviewId,
      );
      const fiber = yield* Deferred.await(registered).pipe(
        // An answered row can be asked about again before its run finishes removing these folders.
        Effect.andThen(Effect.forEach(previous, (run) => Fiber.await(run.fiber))),
        Effect.andThen(answer(question, live)),
        // A stop says so; a shutdown keeps the text and leaves the row for the next start to fail.
        Effect.onInterrupt(() =>
          (live.stopped
            ? move(question.id, { _tag: "stopped" }, live.parts)
            : sql`UPDATE ask_questions SET answer = ${encodeAnswer(live.parts)}
                WHERE id = ${question.id} AND state IN ${sql.in(ACTIVE)}`
          ).pipe(Effect.ignore),
        ),
        Effect.ensuring(
          Effect.forEach(Object.values(foldersOf(question)), (folder) =>
            fs
              .remove(folder, { recursive: true, force: true })
              .pipe(
                Effect.catchTag("PlatformError", (error) =>
                  Effect.logWarning("Couldn't remove the question's files", error).pipe(
                    Effect.annotateLogs({ questionId: question.id }),
                  ),
                ),
              ),
          ).pipe(
            Effect.andThen(
              Effect.sync(() => {
                if (running.get(question.id)?.live === live) running.delete(question.id);
              }),
            ),
          ),
        ),
        // Started at once: a fiber interrupted before it starts never runs its onInterrupt.
        Effect.forkIn(scope, { startImmediately: true }),
      );
      running.set(question.id, { live, fiber });
      yield* Deferred.succeed(registered, undefined);
    });

  /**
   * Stores a question as starting, tells watchers, and starts its answer, as one step a caller
   * going away can't split, so no stored question is left without a run. Watchers get the row
   * before any part of its answer, so a retry's old answer is dropped first. Null when the
   * statement stored nothing.
   */
  const start = <E>(store: Effect.Effect<ReadonlyArray<QuestionRow>, E>) =>
    Effect.gen(function* () {
      const row = (yield* store)[0];
      if (row === undefined) return null;
      const question = toQuestion(row);
      yield* publish(question);
      yield* launch(question);
      return question;
    }).pipe(Effect.uninterruptible);

  /** Why `scope` can't be asked about on this revision, or null when it can. */
  const scopeProblem = (scope: AskScope, context: RevisionContext) => {
    switch (scope._tag) {
      case "pull-request":
      case "local-changes": {
        const subject = subjectOf(context.key);
        return scope._tag === subject ? null : SUBJECTS[subject].otherWhole;
      }
      case "chapter":
        return askedChapter(scope, context.guide) === undefined
          ? `Revision ${context.revision}'s guide has no chapter \`${scope.chapterId}\`.`
          : null;
      case "lines":
        return askedRows(context.snapshot, scope.anchor, context.headSha) === null
          ? `Those lines of ${scope.anchor.path} aren't inside one part of revision ${context.revision}'s diff.`
          : null;
    }
  };

  /**
   * Stores the question and starts answering it in the service's scope, so closing the window
   * never stops it. Returns at once; the answer arrives on `watch`.
   */
  const ask = (input: AskInput) =>
    lifecycle(
      input.reviewId,
      Effect.gen(function* () {
        const context = yield* reviews.revisionContext(input.reviewId, input.revision);
        if (context === null)
          return yield* refuse("not-found", `This review has no guide revision ${input.revision}.`);
        const problem = scopeProblem(input.scope, context);
        if (problem !== null) return yield* refuse("invalid", problem);
        if ((yield* agents.usable(context.agent.instance, context.agent.kind)) === null)
          return yield* refuse("not-ready", AGENT_OFF);
        const id = QuestionId.make(yield* newId);
        const askedBy = yield* StartedBy;
        const at = yield* now;
        const question = yield* start(
          sql`
          INSERT INTO ask_questions (id, review_id, revision, scope, text, asked_by, asked_at, state, run_id)
          SELECT ${id}, ${input.reviewId}, ${input.revision}, ${encodeScope(input.scope)}, ${input.text},
            ${askedBy}, ${at}, 'starting', ${runId}
          WHERE NOT EXISTS (SELECT 1 FROM ask_questions
            WHERE review_id = ${input.reviewId} AND state IN ${sql.in(ACTIVE)})
          RETURNING *`.pipe(Effect.flatMap(decodeQuestions)),
        );
        if (question === null) return yield* refuseBusy(input.reviewId);
        yield* Effect.logInfo("Question asked").pipe(
          Effect.annotateLogs({ questionId: id, reviewId: input.reviewId }),
        );
        return question;
      }),
    ).pipe(
      Effect.catchTags({
        ...storeFailures,
        ReviewError: (error) => refuse("failed", error.message),
      }),
    );

  /** Stops a question that is still being answered, keeping what it wrote. Safe to repeat. */
  const stop = (id: QuestionId) =>
    Effect.gen(function* () {
      const run = running.get(id);
      if (run === undefined) {
        // An answer that ended without recording its outcome left its question with no run to stop.
        yield* move(id, { _tag: "stopped" }, null);
      } else {
        // The run moves its question as it ends. Moving it here as well could stop a retry's run.
        run.live.stopped = true;
        yield* Fiber.interrupt(run.fiber);
      }
      const question = yield* find(id);
      return question ?? (yield* refuse("not-found", "That question doesn't exist."));
    }).pipe(Effect.catchTags(storeFailures));

  /** Answers a stopped or failed question again, in place. Safe to repeat. */
  const retry = (id: QuestionId) =>
    Effect.gen(function* () {
      const asked = yield* find(id);
      if (asked === null) return yield* refuse("not-found", "That question doesn't exist.");
      return yield* lifecycle(asked.reviewId, retryIn(id));
    }).pipe(Effect.catchTags(storeFailures));

  /** Inside the review's turn: answers the question again if it may, or says why not. */
  const retryIn = (id: QuestionId) =>
    Effect.gen(function* () {
      const started = yield* start(
        sql`
          UPDATE ask_questions SET state = 'starting', answer = '[]', failure = NULL, message = NULL,
            instance_id = NULL, provider = NULL, basis = NULL, session_id = NULL,
            agent_pid = NULL, agent_started = NULL, finished_at = NULL, run_id = ${runId}
          WHERE id = ${id} AND state IN ${sql.in(ALLOWED_FROM.starting)}
            AND NOT EXISTS (SELECT 1 FROM ask_questions other
              WHERE other.review_id = ask_questions.review_id AND other.state IN ${sql.in(ACTIVE)})
          RETURNING *`.pipe(Effect.flatMap(decodeQuestions)),
      );
      if (started !== null) return started;
      const question = yield* find(id);
      if (question === null) return yield* refuse("not-found", "That question doesn't exist.");
      switch (question.state._tag) {
        case "starting":
        case "waiting":
        case "answering":
          return question;
        case "answered":
          return yield* refuse("state", "This question already has its answer. Ask another one.");
        case "stopped":
        case "failed":
          return yield* refuseBusy(question.reviewId);
      }
    });

  /** Pins an answered question to its chapter, or unpins it. Safe to repeat. */
  const pin = (id: QuestionId, pinned: boolean) =>
    Effect.gen(function* () {
      const at = yield* now;
      const rows = yield* (
        pinned
          ? sql`UPDATE ask_questions SET pinned_at = COALESCE(pinned_at, ${at})
              WHERE id = ${id} AND state = 'answered' RETURNING *`
          : sql`UPDATE ask_questions SET pinned_at = NULL WHERE id = ${id} RETURNING *`
      ).pipe(Effect.flatMap(decodeQuestions));
      const row = rows[0];
      if (row === undefined)
        return yield* (yield* find(id)) === null
          ? refuse("not-found", "That question doesn't exist.")
          : refuse("state", "Only an answered question can be pinned.");
      const question = toQuestion(row);
      yield* publish(question);
      return question;
    }).pipe(Effect.catchTags(storeFailures));

  /** The review's questions, oldest first, with what is being written right now. */
  const list = (reviewId: ReviewId, revision?: number) =>
    questionsOf(reviewId).pipe(
      Effect.map(({ questions }) =>
        revision === undefined
          ? questions
          : questions.filter((question) => question.revision === revision),
      ),
      Effect.catchTag("SqlError", storeFailures.SqlError),
    );

  /** The review's questions, then every change and every new piece of an answer. */
  const watch = (reviewId: ReviewId): Stream.Stream<AskWatchEvent, AskError> =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribe before reading, so nothing that lands in between is lost.
        const subscription = yield* PubSub.subscribe(changes);
        const opening: AskWatchEvent = yield* questionsOf(reviewId);
        return Stream.concat(
          Stream.succeed(opening),
          Stream.fromSubscription(subscription).pipe(
            Stream.filter((change) => change.reviewId === reviewId),
            Stream.map((change) => change.event),
          ),
        );
      }).pipe(Effect.catchTag("SqlError", storeFailures.SqlError)),
    );

  /**
   * Startup: questions an earlier run left unfinished fail as interrupted, after their agent is
   * stopped if it is still the process that run started. Their checkouts and files go too: the
   * next question makes them again. A second run changes nothing.
   */
  const reconcile = Effect.gen(function* () {
    const [stale, unreadable] = yield* sql`SELECT id, agent_pid, agent_started FROM ask_questions
      WHERE state IN ${sql.in(ACTIVE)} AND run_id != ${runId}`.pipe(Effect.flatMap(decodeStale));
    const at = yield* now;
    const interrupt = (id: string) =>
      Effect.gen(function* () {
        yield* sql`UPDATE ask_questions SET state = 'failed', failure = 'interrupted',
            message = ${INTERRUPTED}, finished_at = ${at}
          WHERE id = ${id} AND state IN ${sql.in(ACTIVE)}`;
        yield* fs.remove(turnTmpDir(path, id), { recursive: true, force: true });
      });
    for (const question of stale) {
      if (question.agent_pid !== null && question.agent_started !== null)
        yield* reapAgentGroup(question.agent_pid, question.agent_started).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
      yield* interrupt(question.id);
    }
    // Its agent can't be told apart from another process, so it is left alone.
    for (const question of unreadable) {
      yield* logDamaged(question);
      if (question.id !== null) yield* interrupt(question.id);
    }
    yield* fs.remove(asksDir, { recursive: true, force: true });
    yield* Effect.logInfo("Reconciled questions").pipe(
      Effect.annotateLogs({ interrupted: stale.length }),
    );
  });

  /**
   * Removes a local review with its questions. The answers still being written stop first, and
   * their rows go only once their agents have, so a crash in between leaves rows startup reaps.
   * No question on the review starts meanwhile. Safe to repeat.
   */
  const removeLocalReview = (key: LocalReviewKey) =>
    Effect.gen(function* () {
      const review = (yield* reviews.local.get(key)).review;
      if (review === null) return yield* reviews.local.remove(key, null);
      // Read inside the review's turn, so a question that started just before is stopped too.
      const stopAll = Effect.suspend(() =>
        Effect.forEach(
          [...running.values()].filter((run) => run.live.reviewId === review.id),
          (run) => {
            run.live.stopped = true;
            return Fiber.interrupt(run.fiber);
          },
          { discard: true },
        ),
      );
      return yield* lifecycle(
        review.id,
        stopAll.pipe(Effect.andThen(reviews.local.remove(key, review.id))),
      );
    }).pipe(Effect.uninterruptible);

  /**
   * Deletes the named questions of the review that prkit still can't read, never one it can,
   * and sends every window watching the review its questions again.
   */
  const removeDamaged = (reviewId: ReviewId, ids: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const { damaged } = yield* questionsOf(reviewId);
          const gone = ids.filter((id) => damaged.includes(id));
          if (gone.length > 0)
            yield* sql`DELETE FROM ask_questions WHERE review_id = ${reviewId} AND id IN ${sql.in(gone)}`;
        }),
      );
      yield* PubSub.publish(changes, { reviewId, event: yield* questionsOf(reviewId) });
    }).pipe(Effect.catchTag("SqlError", storeFailures.SqlError));

  yield* reconcile;

  return { watch, list, ask, stop, retry, pin, removeDamaged, removeLocalReview };
});

export const layer = Layer.effect(Asks, make);
