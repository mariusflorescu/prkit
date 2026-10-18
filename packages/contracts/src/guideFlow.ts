import * as Schema from "effect/Schema";

import type { DiffSnapshot } from "./diffSnapshot.ts";
import {
  type Guide,
  GuideFlowStatus,
  GuideRowDepth,
  type GuideRowStatus,
  type NormalizedGuide,
} from "./guide.ts";
import {
  type GuideCheckContext,
  type Mode,
  type Report,
  checkDiffLine,
  repr,
  resolveChapter,
  trim,
} from "./guideCheck.ts";

type Flow = NonNullable<NormalizedGuide["flow"]>;
type FlowGraph = Extract<Flow, { readonly _tag: "graph" }>;
type BehaviorDiff = Extract<Flow, { readonly _tag: "behavior" }>;
type RawFlow = NonNullable<Guide["flow"]>;

const FLOW_NODES_MAX = 12;
const FLOW_ROWS_MAX = 16;
const FLOW_ROW_TEXT_MAX = 90;

const isDepth = Schema.is(GuideRowDepth);
const statusAliases = new Map<string, typeof GuideFlowStatus.Type>([
  ["added", "added"],
  ["new", "added"],
  ["add", "added"],
  ["changed", "changed"],
  ["modified", "changed"],
  ["updated", "changed"],
  ["removed", "removed"],
  ["deleted", "removed"],
  ["gone", "removed"],
  ["unchanged", "unchanged"],
  ["same", "unchanged"],
  ["existing", "unchanged"],
]);

const outsideHints: Record<typeof GuideRowStatus.Type, string> = {
  added: "",
  removed: " A removed row points at the new-side line next to its `-` lines.",
  unchanged:
    " A context row points at a line of its code the diff shows; leave the row out if the diff doesn't show it.",
};

const normalizeBehavior = (
  raw: RawFlow,
  rows: NonNullable<RawFlow["rows"]>,
  chapterIds: ReadonlyArray<string>,
  snapshot: DiffSnapshot,
  mode: Mode,
  context: GuideCheckContext | null,
  report: Report,
): BehaviorDiff | null => {
  if (rows.length === 0) {
    report.errors.push("`flow.rows` is empty. Send 4-12 rows, or a graph instead.");
    return null;
  }
  if (rows.length > FLOW_ROWS_MAX)
    report.errors.push(
      `\`flow\` has ${rows.length} rows - past ${FLOW_ROWS_MAX} it stops being a quick read. Keep the path the PR changes (4-12 rows) and leave the details to the chapters.`,
    );
  if (rows.every((row) => (row.status ?? "unchanged") === "unchanged"))
    report.errors.push(
      "`flow.rows` has no `added` or `removed` row, so it shows no change. Mark the rows this PR adds or removes.",
    );
  const normalized: Array<BehaviorDiff["rows"][number]> = [];
  let above = -1;
  for (const [index, row] of rows.entries()) {
    const where = `flow row ${index + 1}`;
    const status = row.status ?? "unchanged";
    const depth = row.depth ?? 0;
    const level = isDepth(depth) ? depth : null;
    const text = trim(row.text);
    if (!text)
      report.errors.push(`${where} has no \`text\`. Say in a few plain words what happens.`);
    if (level === null) {
      report.errors.push(
        `${where}: \`depth\` ${depth} must be 0-3. Flatten the tree: four levels is the most that stays readable.`,
      );
    } else {
      if (index === 0 && level > 0)
        report.errors.push(
          `${where}: \`depth\` ${level} has no row above it. The first row is at depth 0.`,
        );
      else if (index > 0 && above >= 0 && level > above + 1)
        report.errors.push(
          `${where}: \`depth\` ${level} follows a row at depth ${above}. A row goes at most one level deeper than the row above it.`,
        );
      above = level;
    }
    if (
      mode === "guide" &&
      status !== "unchanged" &&
      (row.chapter === undefined || row.chapter === "")
    )
      report.errors.push(
        `${where} is ${status} but has no \`chapter\`. Set it to the chapter that explains it, by id or 1-based number.`,
      );
    checkDiffLine(row.at, where, outsideHints[status], snapshot, context, report);
    normalized.push({
      status,
      text,
      depth: level ?? 0,
      at: row.at,
      chapter: resolveChapter(row.chapter, chapterIds, where, report),
    });
  }
  return {
    _tag: "behavior",
    title: raw.title || "How it fits together",
    subtitle: raw.subtitle || null,
    rows: normalized,
  };
};

const normalizeGraph = (
  raw: RawFlow,
  rawNodes: NonNullable<RawFlow["nodes"]>,
  rawEdges: NonNullable<RawFlow["edges"]>,
  chapterIds: ReadonlyArray<string>,
  report: Report,
): FlowGraph | null => {
  const nodes: Array<FlowGraph["nodes"][number]> = [];
  const statuses = new Map<string, FlowGraph["nodes"][number]["status"]>();
  for (const node of rawNodes) {
    const id = trim(node.id);
    if (!id || statuses.has(id)) {
      const nodeRepr =
        "{" +
        Object.entries(node)
          .map(([key, value]) => `${repr(key)}: ${typeof value === "string" ? repr(value) : value}`)
          .join(", ") +
        "}";
      report.errors.push(`flow node ${nodeRepr}: every node needs a unique \`id\`.`);
      continue;
    }
    let status = statusAliases.get((node.status ?? "unchanged").toLowerCase());
    if (status === undefined) {
      report.errors.push(
        `flow node \`${id}\`: status must be added, changed, removed or unchanged.`,
      );
      status = "unchanged";
    }
    statuses.set(id, status);
    nodes.push({
      id,
      label: node.label || id,
      status,
      chapter: resolveChapter(node.chapter, chapterIds, `flow node \`${id}\``, report),
      detail: node.detail || null,
    });
  }
  if (nodes.length === 0) {
    report.errors.push("`flow.nodes` is empty.");
    return null;
  }
  const edges: Array<FlowGraph["edges"][number]> = [];
  for (const edge of rawEdges) {
    const fromStatus = statuses.get(edge.from);
    const toStatus = statuses.get(edge.to);
    if (fromStatus === undefined || toStatus === undefined) {
      report.errors.push(`flow edge ${edge.from} -> ${edge.to}: both ends must be node ids.`);
      continue;
    }
    let status = edge.status;
    if (status === undefined)
      status =
        fromStatus === "added" || toStatus === "added"
          ? "added"
          : fromStatus === "removed" || toStatus === "removed"
            ? "removed"
            : "unchanged";
    edges.push({
      from: edge.from,
      to: edge.to,
      label: edge.label || null,
      status: statusAliases.get(status.toLowerCase()) ?? "unchanged",
    });
  }
  if (nodes.length > FLOW_NODES_MAX)
    report.errors.push(
      `\`flow\` has ${nodes.length} nodes - past ${FLOW_NODES_MAX} it stops being readable. Keep the main path (4-10 nodes), or send a behavior diff (\`rows\`) instead.`,
    );
  const direction = (raw.direction ?? "auto").toUpperCase();
  return {
    _tag: "graph",
    title: raw.title || "How it fits together",
    subtitle: raw.subtitle || null,
    direction: direction === "LR" || direction === "TB" ? direction : "auto",
    nodes,
    edges,
  };
};

export const normalizeFlow = (
  raw: Guide["flow"],
  chapterIds: ReadonlyArray<string>,
  snapshot: DiffSnapshot,
  mode: Mode,
  context: GuideCheckContext | null,
  report: Report,
): Flow | null => {
  if (raw === undefined) {
    if (snapshot.files.some((file) => !/\.(md|mdx|rst|txt|adoc)$/iu.test(file.path)))
      report.warnings.push(
        "no `flow` - a before/after (a graph or a behavior diff) is the fastest way to show what changed. Skip it only if this PR doesn't change what the code does.",
      );
    return null;
  }
  const isGraph = raw.nodes !== undefined || raw.edges !== undefined;
  if (isGraph && raw.rows !== undefined) {
    report.errors.push(
      "`flow` has both a graph (`nodes`/`edges`) and a behavior diff (`rows`). Pick the one form that shows this change best and send `flow` again with only that form.",
    );
    return null;
  }
  if (raw.rows !== undefined)
    return normalizeBehavior(raw, raw.rows, chapterIds, snapshot, mode, context, report);
  if (!isGraph) {
    report.errors.push(
      "`flow` needs a graph (`nodes` and `edges`) or a behavior diff (`rows`). Send one, or if neither helps, call submit_guide again with the whole guide and no `flow`.",
    );
    return null;
  }
  return normalizeGraph(raw, raw.nodes ?? [], raw.edges ?? [], chapterIds, report);
};

export const checkFlowLengths = (flow: NormalizedGuide["flow"], report: Report) => {
  if (flow?._tag === "graph") {
    for (const node of flow.nodes) {
      const length = Array.from(node.label).length;
      if (length > 32)
        report.warnings.push(
          `flow node \`${node.id}\` label is ${length} chars and will be cut off - use one short identifier and put the rest in \`detail\`.`,
        );
    }
  } else if (flow?._tag === "behavior") {
    for (const [index, row] of flow.rows.entries()) {
      const length = Array.from(row.text).length;
      if (length > FLOW_ROW_TEXT_MAX)
        report.warnings.push(
          `flow row ${index + 1} is ${length} characters and will wrap - keep a row to one short line and leave the why to its chapter.`,
        );
    }
  }
};

export function* flowTexts(flow: Flow) {
  yield flow.title;
  yield flow.subtitle ?? "";
  if (flow._tag === "graph") {
    for (const node of flow.nodes) {
      yield node.label;
      yield node.detail ?? "";
    }
    for (const edge of flow.edges) yield edge.label ?? "";
  } else {
    for (const row of flow.rows) yield row.text;
  }
}
