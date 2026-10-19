import {
  FileDiff,
  type DiffLineAnnotation,
  type FileDiffContentsLoader,
  type FileDiffOptions,
} from "@pierre/diffs/react";
import type { AnnotationSide, GetHoveredLineResult, SelectedLineRange } from "@pierre/diffs";
import type { DiffFile, LinePoint } from "@prkit/contracts";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { Button } from "~/components/ui/button";

import { AskLineButton } from "./AskLineButton";
import { DIFF_THEMES } from "./DiffWorkerPoolProvider";
import { GuideNote } from "./GuideNote";
import { MoveChip } from "./MoveChip";
import { useFileMoves, useFileReveal, useFileScopes } from "./diffListContext";
import { useDiffPrefs } from "./diffPrefs";
import { DIFF_CSS } from "./diffStyles";
import { buildFileDiff, fileRows, labelTrailingSeparator } from "./fileDiff";
import { commentsOf } from "./interaction";
import { cellAt, makeLineKeys } from "./lineKeys";
import { movedCss } from "./movedCss";
import { chipLine, type Move } from "./moves";
import { paintScopes } from "./paintScopes";
import type {
  ContentsState,
  DiffAnnotation,
  DiffContents,
  DiffInteraction,
  LineRange,
  LoadContents,
  RevealLines,
} from "./types";

type Pin =
  | { kind: "note"; note: DiffAnnotation; index: number }
  | { kind: "comment"; point: LinePoint }
  | { kind: "move"; end: "cut" | "landed"; move: Move };

const toPierreSide = (side: LinePoint["side"]): AnnotationSide =>
  side === "old" ? "deletions" : "additions";
const pointKey = (point: LinePoint) => `${point.side}:${point.line}`;
const keyPoint = (key: string): LinePoint => {
  const [side, line] = key.split(":");
  return { side: side === "old" ? "old" : "new", line: Number(line) };
};
const fromPierre = (range: SelectedLineRange): LineRange => ({
  start: { side: range.side === "deletions" ? "old" : "new", line: range.start },
  end: {
    side: (range.endSide ?? range.side) === "deletions" ? "old" : "new",
    line: range.end,
  },
});
/**
 * The lines a click on the Ask button asks about: the dock's own lines when the button sits on
 * their last line, where Pierre keeps it while they are selected, else the line it sits on.
 */
const clickedRange = (line: GetHoveredLineResult<"diff">, selection: LineRange | null) => {
  const point: LinePoint = {
    side: line.side === "deletions" ? "old" : "new",
    line: line.lineNumber,
  };
  return selection !== null &&
    selection.end.side === point.side &&
    selection.end.line === point.line
    ? selection
    : { start: point, end: point };
};
const reportCell = (rendered: HTMLElement | null, reveal: RevealLines | null) => {
  const root = rendered?.shadowRoot;
  if (!root || reveal?.range == null) return;
  const cell = cellAt(root, reveal.range.start);
  if (cell) reveal.onCell(cell);
};

export function DiffBody({
  file,
  annotations,
  interaction,
  loadContents,
  trailingLines,
  prUrl,
  fromGuide = false,
  version,
}: {
  file: DiffFile;
  annotations: ReadonlyArray<DiffAnnotation>;
  interaction?: DiffInteraction | undefined;
  loadContents?: LoadContents | undefined;
  trailingLines?: number | undefined;
  prUrl?: string | undefined;
  /** Labels the line notes as the guide's, on a diff that isn't the guide's. */
  fromGuide?: boolean | undefined;
  /** The file's version on its card: a new one is other code, even under the same patch. */
  version?: string | undefined;
}) {
  const { diffStyle, wrap } = useDiffPrefs();
  const moves = useFileMoves(file.path);
  const scopes = useFileScopes(file.path);
  const reveal = useFileReveal(file.path);
  const built = useMemo(() => buildFileDiff(file, version), [file, version]);
  // A push hands this body the new head's file without remounting it, so what the
  // last expansion said stays with the file it was about.
  const [loaded, setLoaded] = useState<{ file: DiffFile; contents: ContentsState }>({
    file,
    contents: { kind: "idle" },
  });
  const contents: ContentsState = loaded.file === file ? loaded.contents : { kind: "idle" };
  const [retry, setRetry] = useState(0);
  const comments = commentsOf(interaction);
  // Pierre re-renders a whole diff when an option or the annotation list changes
  // identity, which also drops the hovered line's comment button until the pointer
  // moves. So the handlers it calls are read through a ref, and pins are keyed by the
  // lines they sit on. Only a file whose comments moved renders again.
  const latest = useRef({ interaction, loadContents, reveal, scopes });
  useLayoutEffect(() => {
    latest.current = { interaction, loadContents, reveal, scopes };
  });
  const loadFiles = useCallback<FileDiffContentsLoader>(async () => {
    const load = latest.current.loadContents;
    const setContents = (next: ContentsState) => setLoaded({ file, contents: next });
    setContents({ kind: "loading" });
    let read: DiffContents | null;
    try {
      read = load ? await load(file) : null;
    } catch (error) {
      const message =
        error instanceof Error
          ? `Could not load unchanged lines. ${error.message}`
          : "Could not load unchanged lines.";
      setContents({ kind: "failed", message });
      throw new Error(message, { cause: error });
    }
    if (!read) {
      const message =
        "Full file contents are unavailable. The changed lines are still shown below.";
      setContents({ kind: "unavailable", message });
      throw new Error(message);
    }
    setContents({ kind: "idle" });
    return {
      oldFile: { name: file.previousPath ?? file.path, contents: read.oldContents },
      newFile: { name: file.path, contents: read.newContents },
    };
  }, [file]);
  const kind = interaction?.kind;
  const [keyRange, setKeyRange] = useState<LineRange | null>(null);
  const [lineKeys] = useState(() => makeLineKeys(setKeyRange));
  const shape = built.kind === "diff" ? built.fileDiff.cacheKey : built.message;
  const [drawn, setDrawn] = useState(shape);
  if (shape !== drawn) {
    setDrawn(shape);
    lineKeys.forget();
  }
  const host = useRef<HTMLElement | null>(null);
  const options = useMemo<FileDiffOptions<Pin, undefined>>(() => {
    const trailing =
      trailingLines === undefined ? undefined : labelTrailingSeparator<Pin>(trailingLines);
    return {
      theme: DIFF_THEMES,
      themeType: "system",
      preferredHighlighter: "shiki-wasm",
      diffStyle,
      overflow: wrap ? "wrap" : "scroll",
      disableFileHeader: true,
      hunkSeparators: "line-info",
      lineDiffType: "word-alt",
      expansionLineCount: 20,
      loadDiffFiles: loadFiles,
      unsafeCSS: DIFF_CSS + movedCss(file, moves),
      onPostRender: (rendered, instance, phase) => {
        trailing?.(rendered, instance, phase);
        host.current = phase === "unmount" ? null : rendered;
        if (host.current?.shadowRoot) paintScopes(host.current.shadowRoot, latest.current.scopes);
        reportCell(host.current, latest.current.reveal);
        if (kind === undefined) return;
        if (phase === "unmount") lineKeys.detach();
        else
          lineKeys.attach(rendered, (range) => latest.current.interaction?.onSelect(range), kind);
      },
      ...(kind !== undefined
        ? {
            enableGutterUtility: true,
            enableLineSelection: true,
            // Pierre takes one gutter API: with our own Ask button, a press on it is a press on
            // the line number, which selection already reports.
            ...(kind === "comment"
              ? {
                  onGutterUtilityClick: (range: SelectedLineRange) =>
                    latest.current.interaction?.onSelect(fromPierre(range)),
                }
              : {}),
            onLineSelectionEnd: (range: SelectedLineRange | null) => {
              if (range !== null) latest.current.interaction?.onSelect(fromPierre(range));
            },
          }
        : {}),
    };
  }, [diffStyle, wrap, loadFiles, trailingLines, kind, lineKeys, file, moves]);
  const chips = useMemo<Array<DiffLineAnnotation<Pin>>>(() => {
    const rows = fileRows(file);
    return [
      ...moves.landed.map((move) => ({
        side: "additions" as const,
        lineNumber: chipLine(rows, move.to),
        metadata: { kind: "move" as const, end: "landed" as const, move },
      })),
      ...moves.cut.map((move) => ({
        side: "deletions" as const,
        lineNumber: chipLine(rows, move.from),
        metadata: { kind: "move" as const, end: "cut" as const, move },
      })),
    ];
  }, [file, moves]);
  const pinKeys = (comments?.pins ?? []).map(pointKey).join(",");
  const lineAnnotations = useMemo<Array<DiffLineAnnotation<Pin>>>(
    () => [
      ...annotations.map((note, index) => ({
        side: note.side,
        lineNumber: note.line,
        metadata: { kind: "note" as const, note, index },
      })),
      ...(pinKeys === "" ? [] : pinKeys.split(",")).map((key) => {
        const point = keyPoint(key);
        return {
          side: toPierreSide(point.side),
          lineNumber: point.line,
          metadata: { kind: "comment" as const, point },
        };
      }),
      // Last, so a chip sits right above its block, under anything about the line above.
      ...chips,
    ],
    [annotations, pinKeys, chips],
  );
  const renderComment = comments?.render;
  const noteFooter = comments?.noteFooter;
  const renderAnnotation = useCallback(
    ({ metadata }: DiffLineAnnotation<Pin>) =>
      metadata.kind === "note" ? (
        <GuideNote
          text={metadata.note.text}
          tone={metadata.note.tone}
          prUrl={prUrl}
          pinned
          fromGuide={fromGuide}
        >
          {noteFooter?.(metadata.note, metadata.index)}
        </GuideNote>
      ) : metadata.kind === "move" ? (
        <MoveChip move={metadata.move} end={metadata.end} />
      ) : (
        renderComment?.(metadata.point)
      ),
    [prUrl, renderComment, noteFooter, fromGuide],
  );
  // Asking has one meaning for a line, so it gets an Ask button in Pierre's gutter slot;
  // comments keep Pierre's own button.
  const renderAskButton = useCallback(
    (hovered: () => GetHoveredLineResult<"diff"> | undefined) => (
      <AskLineButton
        onAsk={() => {
          const line = hovered();
          const { interaction } = latest.current;
          if (line !== undefined && interaction !== undefined)
            interaction.onSelect(clickedRange(line, interaction.selection));
        }}
      />
    ),
    [],
  );
  const selection = interaction?.selection;
  const composing = selection ? `${pointKey(selection.start)},${pointKey(selection.end)}` : "";
  useEffect(() => {
    if (composing === "") lineKeys.restore();
  }, [composing, lineKeys]);
  useLayoutEffect(() => reportCell(host.current, reveal), [reveal]);
  useLayoutEffect(() => {
    const root = host.current?.shadowRoot;
    if (root) paintScopes(root, scopes);
  }, [scopes]);
  const shown = keyRange ?? selection ?? comments?.asked ?? reveal?.range ?? null;
  const selectionKey = shown ? `${pointKey(shown.start)},${pointKey(shown.end)}` : "";
  const selectedLines = useMemo<SelectedLineRange | null>(() => {
    if (selectionKey === "") return null;
    const [start = "", end = ""] = selectionKey.split(",");
    const from = keyPoint(start);
    const to = keyPoint(end);
    return {
      start: from.line,
      side: toPierreSide(from.side),
      end: to.line,
      endSide: toPierreSide(to.side),
    };
  }, [selectionKey]);

  if (built.kind === "message")
    return (
      <div data-diff-placeholder="" role="status">
        <p>{built.message}</p>
        {built.raw && <pre data-diff-raw="">{built.raw}</pre>}
      </div>
    );
  return (
    <>
      {contents.kind === "loading" && (
        <div
          data-diff-contents-status=""
          role="status"
          aria-busy="true"
          aria-label="Loading unchanged lines"
        >
          Loading unchanged lines...
        </div>
      )}
      {(contents.kind === "failed" || contents.kind === "unavailable") && (
        <div data-diff-contents-status="" role={contents.kind === "failed" ? "alert" : "status"}>
          <p>{contents.message}</p>
          <Button
            size="compact"
            variant="outline"
            onClick={() => {
              setLoaded({ file, contents: { kind: "idle" } });
              setRetry((value) => value + 1);
            }}
          >
            Retry
          </Button>
        </div>
      )}
      <FileDiff
        key={retry}
        fileDiff={built.fileDiff}
        options={options}
        lineAnnotations={lineAnnotations}
        renderAnnotation={renderAnnotation}
        selectedLines={selectedLines}
        {...(kind === "ask" ? { renderGutterUtility: renderAskButton } : {})}
        className="block [color-scheme:inherit]"
      />
    </>
  );
}
