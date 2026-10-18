import type { DiffFile, DiffLineRef, DiffSnapshot, NormalizedGuide } from "@prkit/contracts";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import {
  DiffControls,
  DiffWorkerPoolProvider,
  type DiffComments,
  type LoadContents,
} from "~/components/diff";
import { RenderBoundary } from "~/components/diff/RenderBoundary";
import { TabActions, useHasTabActions } from "~/components/TabActions";

import { ChapterSection } from "./ChapterSection";
import { GuideOverview } from "./GuideOverview";
import { PendingChapter } from "./PendingChapter";
import type { LineJump } from "./types";
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
}: GuideViewProps) {
  const prefix = useId();
  const inTabRow = useHasTabActions();
  const viewportRef = useRef<HTMLDivElement>(null);
  const cleanupScroll = useRef<(() => void) | null>(null);
  const files = useMemo(() => new Map(snapshot.files.map((file) => [file.path, file])), [snapshot]);
  const [collapsed, setCollapsed] = useState<ReadonlyMap<string, boolean>>(() => new Map());
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
  useChapterKeyboard(viewportRef, onChapter);
  useEffect(() => () => cleanupScroll.current?.(), []);

  return (
    <DiffWorkerPoolProvider>
      <div data-guide-view="">
        <div data-guide-toolbar="">
          <span>
            Guided review <small>j / k to move between chapters</small>
          </span>
          {inTabRow ? (
            <TabActions>
              <DiffControls />
            </TabActions>
          ) : (
            <DiffControls />
          )}
        </div>
        <div ref={viewportRef} data-guide-scroll="">
          <div data-guide-content="">
            <RenderBoundary title="The guide overview">
              <GuideOverview
                guide={guide}
                files={files}
                onChapter={onChapter}
                onLine={onLine}
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
              return (
                <RenderBoundary key={chapter.id} title={`Chapter ${index + 1}`}>
                  <ChapterSection
                    chapter={chapter}
                    index={index}
                    total={draft?.growing === true ? null : guide.chapters.length}
                    files={files}
                    id={chapterId(chapter.id)}
                    fileId={fileId}
                    open={!isCollapsed}
                    onToggle={() =>
                      setCollapsed((previous) => new Map(previous).set(chapter.id, !isCollapsed))
                    }
                    onFile={(path) => scrollTo(byId(fileId(path)))}
                    jump={jump && owners.get(jump.path) === chapter.id ? jump : null}
                    loadContents={loadContents}
                    comments={comments}
                    prUrl={prUrl}
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
