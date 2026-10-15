import * as NodeWorker from "node:worker_threads";

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * grep's matching, in a worker thread with a deadline. The pattern is the agent's, and a pull
 * request can carry both a line that makes a backtracking pattern take minutes and the words
 * that ask for it; on the runner's own thread that would hold the turn until Stop.
 */

/** How long one grep call may match before prkit stops it. */
export const SEARCH_DEADLINE_MS = 5000;

export interface SearchJob {
  /** Files already checked to be readable: real paths in the checkout or a readable folder. */
  readonly files: ReadonlyArray<string>;
  readonly pattern: string;
  readonly flags: string;
  readonly maxFileBytes: number;
  readonly maxMatches: number;
}

const Found = Schema.fromJsonString(
  Schema.Struct({
    matches: Schema.Array(Schema.Tuple([Schema.String, Schema.Number, Schema.String])),
    more: Schema.Boolean,
  }),
);
export type Found = typeof Found.Type;

// Plain JavaScript run with `eval`, so the bundled runner needs no second file.
const WORKER = `
const { workerData, parentPort } = require("node:worker_threads");
const fs = require("node:fs");
const { files, pattern, flags, maxFileBytes, maxMatches } = workerData;
const regex = new RegExp(pattern, flags);
const matches = [];
let more = false;
search: for (const file of files) {
  let bytes;
  try {
    if (fs.statSync(file).size > maxFileBytes) continue;
    bytes = fs.readFileSync(file);
  } catch {
    continue;
  }
  if (bytes.subarray(0, 8000).includes(0)) continue;
  const lines = bytes.toString("utf8").split("\\n");
  for (let index = 0; index < lines.length; index++) {
    if (!regex.test(lines[index])) continue;
    if (matches.length >= maxMatches) {
      more = true;
      break search;
    }
    matches.push([file, index + 1, lines[index]]);
  }
}
parentPort.postMessage(JSON.stringify({ matches, more }));
`;

/** Each matching line as [file, line number, text]; `slow` when the deadline passed first. */
export const searchFiles = (job: SearchJob, deadlineMs = SEARCH_DEADLINE_MS) =>
  new Promise<Found | "slow" | "failed">((resolve) => {
    const worker = new NodeWorker.Worker(WORKER, { eval: true, workerData: job });
    const done = (result: Found | "slow" | "failed") => {
      clearTimeout(timer);
      void worker.terminate();
      resolve(result);
    };
    // @effect-diagnostics-next-line globalTimers:off -- a plain promise in the runner, outside the Effect runtime
    const timer = setTimeout(() => done("slow"), deadlineMs);
    worker.once("message", (text: string) =>
      done(Option.getOrElse(Schema.decodeUnknownOption(Found)(text), () => "failed" as const)),
    );
    worker.once("error", () => done("failed"));
  });
