import type { DiffFile, DiffSnapshot, NormalizedGuide } from "@prkit/contracts";
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

  const scrollTo = useCallback((id: string) => {
    cleanupScroll.current?.();
    const viewport = viewportRef.current;
    if (!viewport) return;
    const align = () => {
      const element = document.getElementById(id);
      element?.scrollIntoView({ block: "start", behavior: "instant" });
    };
    const observer = new ResizeObserver(align);
    const stop = () => {
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
      align();
      document.getElementById(id)?.focus({ preventScroll: true });
    });
    for (const event of ["wheel", "touchstart", "keydown", "mousedown"])
      viewport.addEventListener(event, stop, { passive: true });
    cleanupScroll.current = stop;
  }, []);

  const onChapter = useCallback(
    (id: string) => {
      setCollapsed((previous) => new Map(previous).set(id, false));
      scrollTo(chapterId(id));
    },
    [chapterId, scrollTo],
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
                    onFile={(path) => scrollTo(fileId(path))}
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
