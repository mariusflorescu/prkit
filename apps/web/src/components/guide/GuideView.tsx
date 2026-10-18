import {
  chapterReview,
  type DiffFile,
  type DiffLineRef,
  type DiffSnapshot,
  type NormalizedGuide,
} from "@prkit/contracts";
import { type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";

import {
  DiffControls,
  DiffWorkerPoolProvider,
  type DiffComments,
  type LoadContents,
} from "~/components/diff";
import { alignIfAbove } from "~/components/diff/readingLine";
import { RenderBoundary } from "~/components/diff/RenderBoundary";
import { useReviewedKey } from "~/components/diff/useReviewedKey";
import { TabActions, useHasTabActions } from "~/components/TabActions";

import { ChapterSection } from "./ChapterSection";
import { GuideOverview } from "./GuideOverview";
import { PendingChapter } from "./PendingChapter";
import type { GuideChapter, LineJump, ReviewedBinding } from "./types";
import { useChapterKeyboard } from "./useChapterKeyboard";
import "./guide.css";

export type GuideViewProps = {
  guide: NormalizedGuide;
  snapshot: DiffSnapshot;
  prUrl?: string;
  prDescription?: string;
  loadContents?: LoadContents;
  /** Review comments on the chapters' diffs; without it they stay read-only. */
  comments?: (file: DiffFile) => DiffComments | undefined;
  /** Chapters a streaming draft has planned but not written yet: shown as faded titles. */
  pendingChapterIds?: ReadonlySet<string>;
  /**
   * A draft the agent is still writing, so more may come after the last chapter.
   * `growing` while it is still adding chapters: their count is not a total yet.
   */
  draft?: { readonly growing: boolean };
  /** Reviewed checkboxes on files and chapters; without it there are none. */
  reviewed?: ReviewedBinding | undefined;
  /** Shown before the diff controls, such as how many files are reviewed. */
  count?: ReactNode;
};

const noPending: ReadonlySet<string> = new Set();

type ScrollTarget = () => {
  readonly element: Element;
  readonly block: ScrollLogicalPosition;
  readonly focus: HTMLElement;
} | null;

const byId =
  (id: string): ScrollTarget =>
  () => {
    const element = document.getElementById(id);
    return element && { element, block: "start", focus: element };
  };

export function GuideView({
  guide,
  snapshot,
  prUrl,
  prDescription,
  loadContents,
  comments,
  pendingChapterIds = noPending,
  draft,
  reviewed,
  count,
}: GuideViewProps) {
  const prefix = useId();
  const inTabRow = useHasTabActions();
  const viewportRef = useRef<HTMLDivElement>(null);
  const cleanupScroll = useRef<(() => void) | null>(null);
  const files = useMemo(() => new Map(snapshot.files.map((file) => [file.path, file])), [snapshot]);
  const filesOf = useCallback(
    (chapter: GuideChapter) =>
      chapter.files.flatMap((entry) => {
        const file = files.get(entry.path);
        return file === undefined ? [] : [file];
      }),
    [files],
  );
  // Chapters already reviewed start closed. Marks that arrive later never fold or unfold one.
  const [collapsed, setCollapsed] = useState<ReadonlyMap<string, boolean>>(
    () =>
      new Map(
        reviewed === undefined
          ? []
          : guide.chapters
              .filter(
                (chapter) =>
                  chapterReview(filesOf(chapter), reviewed.stateOf)?.state === "reviewed",
              )
              .map((chapter): [string, boolean] => [chapter.id, true]),
      ),
  );
  // Bumped when a chapter is unticked, so its open cards open their files like unticked files.
  const [reopened, setReopened] = useState<ReadonlyMap<string, number>>(() => new Map());
  const chapterId = useCallback((id: string) => `${prefix}-chapter-${id}`, [prefix]);
  const fileId = useCallback((path: string) => `${prefix}-file-${path}`, [prefix]);
  const owners = useMemo(() => {
    const owners = new Map<string, string>();
    for (const chapter of guide.chapters)
      for (const file of chapter.files)
        if (!owners.has(file.path)) owners.set(file.path, chapter.id);
    return owners;
  }, [guide.chapters]);
  const [jump, setJump] = useState<LineJump | null>(null);
  // A draft shows the risk card from the start, so nothing moves when the agent rates it.
  const rated =
    draft !== undefined ||
    guide.risk !== null ||
    guide.signals.length > 0 ||
    guide.chapters.some((chapter) => chapter.risk !== null);

  const scrollTo = useCallback((target: ScrollTarget) => {
    cleanupScroll.current?.();
    const viewport = viewportRef.current;
    if (!viewport) return () => {};
    let aligning = true;
    const realign = () => {
      const found = aligning ? target() : null;
      found?.element.scrollIntoView({ block: found.block, behavior: "instant" });
    };
    const observer = new ResizeObserver(realign);
    const stop = () => {
      aligning = false;
      observer.disconnect();
      window.clearTimeout(timeout);
      window.cancelAnimationFrame(frame);
      for (const event of ["wheel", "touchstart", "keydown", "mousedown"])
        viewport.removeEventListener(event, stop);
    };
    // Keep the target aligned while deferred diffs replace their estimated heights.
    const timeout = window.setTimeout(stop, 3000);
    const frame = window.requestAnimationFrame(() => {
      if (viewport.firstElementChild) observer.observe(viewport.firstElementChild);
      realign();
      target()?.focus.focus({ preventScroll: true });
    });
    for (const event of ["wheel", "touchstart", "keydown", "mousedown"])
      viewport.addEventListener(event, stop, { passive: true });
    cleanupScroll.current = stop;
    return realign;
  }, []);

  const onChapter = useCallback(
    (id: string) => {
      setCollapsed((previous) => new Map(previous).set(id, false));
      scrollTo(byId(chapterId(id)));
    },
    [chapterId, scrollTo],
  );
  const onLine = useCallback(
    (at: DiffLineRef) => {
      const owner = owners.get(at.path);
      if (owner === undefined) return;
      setCollapsed((previous) => new Map(previous).set(owner, false));
      let cell: HTMLElement | null = null;
      const realign = scrollTo(() => {
        const card = document.getElementById(fileId(at.path));
        if (!card) return null;
        return cell?.isConnected
          ? { element: cell, block: "center", focus: card }
          : { element: card, block: "start", focus: card };
      });
      const onCell = (found: HTMLElement) => {
        cell = found;
        realign();
      };
      setJump({ path: at.path, reveal: { line: at.line, onCell } });
    },
    [owners, fileId, scrollTo],
  );
  const onFile = useCallback(
    (path: string) => {
      const owner = owners.get(path);
      if (owner === undefined) return;
      setCollapsed((previous) => new Map(previous).set(owner, false));
      setJump({ path, reveal: { line: null } });
      scrollTo(byId(fileId(path)));
    },
    [owners, fileId, scrollTo],
  );
  const reviewChapter = async (chapter: GuideChapter, next: boolean) => {
    if (reviewed === undefined) return false;
    const saved = await reviewed.set(filesOf(chapter), next);
    if (!saved) return false;
    flushSync(() => {
      setCollapsed((previous) => new Map(previous).set(chapter.id, next));
      if (!next)
        setReopened((previous) =>
          new Map(previous).set(chapter.id, (previous.get(chapter.id) ?? 0) + 1),
        );
    });
    const section = document.getElementById(chapterId(chapter.id));
    if (next && section) alignIfAbove(section);
    return true;
  };
  useChapterKeyboard(viewportRef, onChapter);
  useReviewedKey(viewportRef, reviewed === undefined ? null : "[data-guide-chapter]");
  useEffect(() => () => cleanupScroll.current?.(), []);

  return (
    <DiffWorkerPoolProvider>
      <div data-guide-view="">
        <div data-guide-toolbar="">
          <span>
            Guided review{" "}
            <small>
              j / k to move between chapters
              {reviewed === undefined ? null : " · r to mark reviewed"}
            </small>
          </span>
          {inTabRow ? (
            <TabActions>
              {count}
              <DiffControls />
            </TabActions>
          ) : (
            <div className="flex items-center">
              {count}
              <DiffControls />
            </div>
          )}
        </div>
        <div ref={viewportRef} data-guide-scroll="">
          <div data-guide-content="">
            <RenderBoundary title="The guide overview">
              <GuideOverview
                guide={guide}
                files={files}
                rated={rated}
                onChapter={onChapter}
                onLine={onLine}
                onFile={onFile}
                prUrl={prUrl}
                prDescription={prDescription}
                pendingChapterIds={pendingChapterIds}
              />
            </RenderBoundary>
            {guide.chapters.map((chapter, index) => {
              if (pendingChapterIds.has(chapter.id))
                return (
                  <PendingChapter
                    key={chapter.id}
                    title={chapter.title}
                    index={index}
                    total={guide.chapters.length}
                    id={chapterId(chapter.id)}
                  />
                );
              const isCollapsed = collapsed.get(chapter.id) ?? chapter.kind === "generated";
              const review =
                reviewed === undefined ? null : chapterReview(filesOf(chapter), reviewed.stateOf);
              return (
                <RenderBoundary key={chapter.id} title={`Chapter ${index + 1}`}>
                  <ChapterSection
                    chapter={chapter}
                    index={index}
                    total={draft?.growing === true ? null : guide.chapters.length}
                    files={files}
                    id={chapterId(chapter.id)}
                    reopened={reopened.get(chapter.id) ?? 0}
                    fileId={fileId}
                    open={!isCollapsed}
                    rated={rated}
                    onToggle={() =>
                      setCollapsed((previous) => new Map(previous).set(chapter.id, !isCollapsed))
                    }
                    onLine={onLine}
                    onFile={onFile}
                    jump={jump && owners.get(jump.path) === chapter.id ? jump : null}
                    loadContents={loadContents}
                    comments={comments}
                    prUrl={prUrl}
                    reviewed={reviewed}
                    review={
                      review === null
                        ? null
                        : { review, onChange: (next) => reviewChapter(chapter, next) }
                    }
                  />
                </RenderBoundary>
              );
            })}
            <footer data-guide-footer="">
              {draft !== undefined || pendingChapterIds.size > 0 ? (
                "The agent is still writing the rest of this guide."
              ) : (
                <>
                  That is the whole guide. {snapshot.files.length} changed file
                  {snapshot.files.length === 1 ? "" : "s"}.
                </>
              )}
            </footer>
          </div>
        </div>
      </div>
    </DiffWorkerPoolProvider>
  );
}
