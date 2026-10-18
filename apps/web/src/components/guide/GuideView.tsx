import {
  chapterReview,
  type DiffFile,
  type DiffLineRef,
  type DiffSnapshot,
  type DiffSource,
  type NormalizedGuide,
} from "@prkit/contracts";
import { type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";

import {
  DiffControls,
  DiffList,
  type DiffComments,
  type DiffListHandle,
  type LoadContents,
} from "~/components/diff";
import { alignScroll, type ScrollTarget } from "~/components/diff/alignScroll";
import { alignIfAbove } from "~/components/diff/readingLine";
import { RenderBoundary } from "~/components/diff/RenderBoundary";
import { useReviewedKey } from "~/components/diff/useReviewedKey";
import { TabActions, useHasTabActions } from "~/components/TabActions";

import { ChapterRail } from "./ChapterRail";
import { railTicks } from "./railTicks";
import { ChapterSection } from "./ChapterSection";
import { GuideOverview } from "./GuideOverview";
import { PendingChapter } from "./PendingChapter";
import type { GuideChapter, ReviewedBinding } from "./types";
import { useChapterKeyboard } from "./useChapterKeyboard";
import { useReadingPin } from "./useReadingPin";
import "./guide.css";

export type GuideViewProps = {
  guide: NormalizedGuide;
  snapshot: DiffSnapshot;
  /** Where the snapshot's new side is read for the scope lines; null reads nothing. */
  source: DiffSource | null;
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

const byId =
  (id: string): ScrollTarget =>
  () => {
    const element = document.getElementById(id);
    return element && { element, block: "start", focus: element };
  };

export function GuideView({
  guide,
  snapshot,
  source,
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
  const stopScroll = useRef<(() => void) | null>(null);
  const files = useMemo(() => new Map(snapshot.files.map((file) => [file.path, file])), [snapshot]);
  const filesOf = useCallback(
    (chapter: GuideChapter) =>
      chapter.files.flatMap((entry) => {
        const file = files.get(entry.path);
        return file === undefined ? [] : [file];
      }),
    [files],
  );
  // The one answer to "how far is this chapter reviewed", for its header and its rail tick.
  const reviewOf = useCallback(
    (chapter: GuideChapter) =>
      reviewed === undefined ? null : chapterReview(filesOf(chapter), reviewed.stateOf),
    [reviewed, filesOf],
  );
  // Chapters already reviewed start closed. Marks that arrive later never fold or unfold one.
  const [collapsed, setCollapsed] = useState<ReadonlyMap<string, boolean>>(
    () =>
      new Map(
        guide.chapters
          .filter((chapter) => reviewOf(chapter)?.state === "reviewed")
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
  // A draft shows the risk card from the start, so nothing moves when the agent rates it.
  const rated =
    draft !== undefined ||
    guide.risk !== null ||
    guide.signals.length > 0 ||
    guide.chapters.some((chapter) => chapter.risk !== null);
  const [pinned, setPinned] = useReadingPin(viewportRef);

  const scrollTo = useCallback((target: ScrollTarget) => {
    const viewport = viewportRef.current;
    if (viewport)
      stopScroll.current = alignScroll(viewport, viewport.firstElementChild, target).stop;
  }, []);

  const onChapter = useCallback(
    (id: string) => {
      setPinned(id);
      setCollapsed((previous) => new Map(previous).set(id, false));
      scrollTo(byId(chapterId(id)));
    },
    [chapterId, scrollTo, setPinned],
  );
  const list = useRef<DiffListHandle>(null);
  const onLine = useCallback(
    (at: DiffLineRef) =>
      list.current?.goTo({
        path: at.path,
        range: { start: { side: "new", line: at.line }, end: { side: "new", line: at.line } },
      }),
    [],
  );
  const onFile = useCallback((path: string) => list.current?.goTo({ path, range: null }), []);
  const locate = useCallback(
    (path: string) => {
      const owner = owners.get(path);
      return owner === undefined
        ? null
        : () => setCollapsed((previous) => new Map(previous).set(owner, false));
    },
    [owners],
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
  useChapterKeyboard(viewportRef, onChapter, pinned);
  useReviewedKey(viewportRef, reviewed === undefined ? null : "[data-guide-chapter]");
  useEffect(() => () => stopScroll.current?.(), []);

  const ticks = useMemo(
    () => railTicks(guide.chapters, pendingChapterIds, reviewOf, rated),
    [guide.chapters, pendingChapterIds, reviewOf, rated],
  );

  return (
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
          {ticks.length >= 2 && (
            <ChapterRail
              ticks={ticks}
              total={draft?.growing === true ? null : ticks.length}
              pinned={pinned}
              onChapter={onChapter}
            />
          )}
          <DiffList ref={list} files={snapshot.files} source={source} locate={locate}>
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
                    chapterId={chapter.id}
                  />
                );
              const isCollapsed = collapsed.get(chapter.id) ?? chapter.kind === "generated";
              const review = reviewOf(chapter);
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
          </DiffList>
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
  );
}
