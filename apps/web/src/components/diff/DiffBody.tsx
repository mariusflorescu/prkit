import {
  FileDiff,
  type DiffLineAnnotation,
  type FileDiffContentsLoader,
  type FileDiffOptions,
} from "@pierre/diffs/react";
import type { AnnotationSide, SelectedLineRange } from "@pierre/diffs";
import type { DiffFile, LinePoint } from "@prkit/contracts";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { Button } from "~/components/ui/button";

import { DIFF_THEMES } from "./DiffWorkerPoolProvider";
import { GuideNote } from "./GuideNote";
import { useDiffPrefs } from "./diffPrefs";
import { DIFF_CSS } from "./diffStyles";
import { buildFileDiff, labelTrailingSeparator } from "./fileDiff";
import { makeLineKeys } from "./lineKeys";
import type {
  ContentsState,
  DiffAnnotation,
  DiffComments,
  DiffContents,
  LineRange,
  LoadContents,
} from "./types";

type Pin = { kind: "note"; note: DiffAnnotation } | { kind: "comment"; point: LinePoint };

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

export function DiffBody({
  file,
  annotations,
  comments,
  loadContents,
  trailingLines,
  prUrl,
}: {
  file: DiffFile;
  annotations: ReadonlyArray<DiffAnnotation>;
  comments?: DiffComments | undefined;
  loadContents?: LoadContents | undefined;
  trailingLines?: number | undefined;
  prUrl?: string | undefined;
}) {
  const { diffStyle, wrap } = useDiffPrefs();
  const built = useMemo(() => buildFileDiff(file), [file]);
  // A push hands this body the new head's file without remounting it, so what the
  // last expansion said stays with the file it was about.
  const [loaded, setLoaded] = useState<{ file: DiffFile; contents: ContentsState }>({
    file,
    contents: { kind: "idle" },
  });
  const contents: ContentsState = loaded.file === file ? loaded.contents : { kind: "idle" };
  const [retry, setRetry] = useState(0);
  // Pierre re-renders a whole diff when an option or the annotation list changes
  // identity, which also drops the hovered line's comment button until the pointer
  // moves. So the handlers it calls are read through a ref, and pins are keyed by the
  // lines they sit on. Only a file whose comments moved renders again.
  const latest = useRef({ comments, loadContents });
  useLayoutEffect(() => {
    latest.current = { comments, loadContents };
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
          : "Could not load unchanged lines. Try again.";
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
  const commentable = comments !== undefined;
  const [keyRange, setKeyRange] = useState<LineRange | null>(null);
  const [lineKeys] = useState(() => makeLineKeys(setKeyRange));
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
      unsafeCSS: DIFF_CSS,
      ...(trailing === undefined && !commentable
        ? {}
        : {
            onPostRender: (host, instance, phase) => {
              trailing?.(host, instance, phase);
              if (!commentable) return;
              if (phase === "unmount") lineKeys.detach();
              else lineKeys.attach(host, (range) => latest.current.comments?.onSelect(range));
            },
          }),
      ...(commentable
        ? {
            enableGutterUtility: true,
            enableLineSelection: true,
            onGutterUtilityClick: (range: SelectedLineRange) =>
              latest.current.comments?.onSelect(fromPierre(range)),
            onLineSelectionEnd: (range: SelectedLineRange | null) => {
              if (range !== null) latest.current.comments?.onSelect(fromPierre(range));
            },
          }
        : {}),
    };
  }, [diffStyle, wrap, loadFiles, trailingLines, commentable, lineKeys]);
  const pinKeys = (comments?.pins ?? []).map(pointKey).join(",");
  const lineAnnotations = useMemo<Array<DiffLineAnnotation<Pin>>>(
    () => [
      ...annotations.map((note) => ({
        side: note.side,
        lineNumber: note.line,
        metadata: { kind: "note" as const, note },
      })),
      ...(pinKeys === "" ? [] : pinKeys.split(",")).map((key) => {
        const point = keyPoint(key);
        return {
          side: toPierreSide(point.side),
          lineNumber: point.line,
          metadata: { kind: "comment" as const, point },
        };
      }),
    ],
    [annotations, pinKeys],
  );
  const renderComment = comments?.render;
  const renderAnnotation = useCallback(
    (annotation: DiffLineAnnotation<Pin>) =>
      annotation.metadata.kind === "note" ? (
        <GuideNote
          text={annotation.metadata.note.text}
          tone={annotation.metadata.note.tone}
          prUrl={prUrl}
          pinned
        />
      ) : (
        renderComment?.(annotation.metadata.point)
      ),
    [prUrl, renderComment],
  );
  const selection = comments?.selection;
  const composing = selection ? `${pointKey(selection.start)},${pointKey(selection.end)}` : "";
  useEffect(() => {
    if (composing === "") lineKeys.restore();
  }, [composing, lineKeys]);
  const shown = keyRange ?? selection;
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
        className="block [color-scheme:inherit]"
      />
    </>
  );
}
