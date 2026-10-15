import * as NodeWorker from "node:worker_threads";

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * glob's and grep's matching, in a worker thread with a deadline. The patterns are the agent's,
 * and a pull request can carry both a name or line that makes a pattern take minutes and the
 * words that ask for it; on the runner's own thread that would hold the turn until Stop.
 */

/** How long one glob or grep call may match before prkit stops it. */
export const SEARCH_DEADLINE_MS = 5000;

export type SearchJob =
  /** The names, relative to the folder searched, that match `glob`: for glob. */
  | {
      readonly kind: "names";
      readonly names: ReadonlyArray<string>;
      readonly glob: string;
      readonly maxNames: number;
    }
  /** Each line of `files` matching `pattern`, of the files whose name under `base` matches `glob`: for grep. */
  | {
      readonly kind: "lines";
      /** Files already checked to be readable: real paths in the checkout or a readable folder. */
      readonly files: ReadonlyArray<string>;
      readonly base: string;
      readonly glob: string | null;
      readonly pattern: string;
      readonly flags: string;
      readonly maxFileBytes: number;
      readonly maxMatches: number;
    };

const Names = Schema.fromJsonString(
  Schema.Struct({ names: Schema.Array(Schema.String), more: Schema.Boolean }),
);
const Lines = Schema.fromJsonString(
  Schema.Struct({
    matches: Schema.Array(Schema.Tuple([Schema.String, Schema.Number, Schema.String])),
    more: Schema.Boolean,
  }),
);

// Plain JavaScript run with `eval`, so the bundled runner needs no second file.
const WORKER = `
const { workerData: job, parentPort } = require("node:worker_threads");
const fs = require("node:fs");
const path = require("node:path");
if (job.kind === "names") {
  const names = [];
  let more = false;
  for (const name of job.names) {
    if (!path.matchesGlob(name, job.glob)) continue;
    if (names.length >= job.maxNames) {
      more = true;
      break;
    }
    names.push(name);
  }
  parentPort.postMessage(JSON.stringify({ names, more }));
} else {
  const regex = new RegExp(job.pattern, job.flags);
  const matches = [];
  let more = false;
  search: for (const file of job.files) {
    if (job.glob !== null && !path.matchesGlob(path.relative(job.base, file), job.glob)) continue;
    let bytes;
    try {
      if (fs.statSync(file).size > job.maxFileBytes) continue;
      bytes = fs.readFileSync(file);
    } catch {
      continue;
    }
    if (bytes.subarray(0, 8000).includes(0)) continue;
    const lines = bytes.toString("utf8").split("\\n");
    for (let index = 0; index < lines.length; index++) {
      if (!regex.test(lines[index])) continue;
      if (matches.length >= job.maxMatches) {
        more = true;
        break search;
      }
      matches.push([file, index + 1, lines[index]]);
    }
  }
  parentPort.postMessage(JSON.stringify({ matches, more }));
}
`;

const run = <A>(job: SearchJob, decode: (text: string) => Option.Option<A>, deadlineMs: number) =>
  new Promise<A | "slow" | "failed">((resolve) => {
    const worker = new NodeWorker.Worker(WORKER, { eval: true, workerData: job });
    const done = (result: A | "slow" | "failed") => {
      clearTimeout(timer);
      void worker.terminate();
      resolve(result);
    };
    // @effect-diagnostics-next-line globalTimers:off -- a plain promise in the runner, outside the Effect runtime
    const timer = setTimeout(() => done("slow"), deadlineMs);
    worker.once("message", (text: string) =>
      done(Option.getOrElse(decode(text), () => "failed" as const)),
    );
    worker.once("error", () => done("failed"));
  });

/** The names matching a glob; `slow` when the deadline passed first. */
export const matchNames = (
  job: Omit<Extract<SearchJob, { kind: "names" }>, "kind">,
  deadlineMs = SEARCH_DEADLINE_MS,
) => run({ kind: "names", ...job }, Schema.decodeUnknownOption(Names), deadlineMs);

/** Each matching line as [file, line number, text]; `slow` when the deadline passed first. */
export const searchFiles = (
  job: Omit<Extract<SearchJob, { kind: "lines" }>, "kind">,
  deadlineMs = SEARCH_DEADLINE_MS,
) => run({ kind: "lines", ...job }, Schema.decodeUnknownOption(Lines), deadlineMs);
