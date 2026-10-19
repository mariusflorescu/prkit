import type { DiffFile, PullRequestDetail, PullRequestFiles as Files } from "@prkit/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpenTextIcon, FolderTreeIcon } from "lucide-react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";

import {
  DiffControls,
  DiffList,
  FileDiffCard,
  type DiffListHandle,
  type LoadContents,
} from "~/components/diff";
import { useReviewedKey } from "~/components/diff/useReviewedKey";
import { Skeleton } from "~/components/ui/skeleton";
import { TabActions } from "~/components/TabActions";
import { ToolbarIconButton } from "~/components/ToolbarIconButton";
import { ListError } from "~/components/ListError";
import { FilesGuideNotesStatus } from "~/features/guideNotes/FilesGuideNotesStatus";
import type { FileGuideNotes } from "~/features/guideNotes/placeGuideNotes";
import { useFilesGuideNotes } from "~/features/guideNotes/useFilesGuideNotes";
import { useGuideNotesOnFiles } from "~/features/guideNotes/useGuideNotesOnFiles";
import { ReviewedCount } from "~/features/reviewedFiles/ReviewedCount";
import { useReviewedFiles, versionOf } from "~/features/reviewedFiles/useReviewedFiles";
import { ReviewCommentsAlerts } from "~/features/reviewComments/ReviewCommentsAlerts";
import { CommentsWithoutDiff } from "~/features/reviewComments/CommentsWithoutDiff";
import { useReviewCommentsStore, writingOn } from "~/features/reviewComments/reviewCommentsStore";
import { useDiffComments } from "~/features/reviewComments/useDiffComments";
import {
  pendingCommentsQuery,
  pullRequestFileContentsQuery,
  pullRequestFilesQuery,
  reviewThreadsQuery,
} from "~/rpc/queries";
import { readViewMemory } from "~/features/workspace/sessionStore";
import { FilesTreePanel } from "./FilesTreePanel";
import { usePrViewStore } from "./prViewStore";
import { orderDiffFiles } from "./pullRequestFileOrder";
import { useFilesFilter } from "./useFilesFilter";
import { useFilterKey } from "./useFilterKey";
import "./pullRequest.css";

const noNotes: FileGuideNotes["annotations"] = [];

const toDiffFiles = (files: Files["files"]): DiffFile[] =>
  files.map((file) => {
    const oldPath = JSON.stringify(`a/${file.previousPath ?? file.path}`);
    const newPath = JSON.stringify(`b/${file.path}`);
    return {
      ...file,
      status:
        file.status === "copied"
          ? "added"
          : file.status === "changed" || file.status === "unchanged"
            ? "modified"
            : file.status,
      patch:
        file.patch._tag === "text" && file.patch.patch !== ""
          ? {
              _tag: "text",
              patch: `diff --git ${oldPath} ${newPath}\n--- ${file.status === "added" ? "/dev/null" : oldPath}\n+++ ${file.status === "removed" ? "/dev/null" : newPath}\n${file.patch.patch}\n`,
            }
          : file.patch,
    };
  });

const converted = new WeakMap<Files, ReadonlyArray<DiffFile>>();
const noFiles: ReadonlyArray<DiffFile> = [];
/** One files array per answer, so coming back to a PR finds its moves already worked out. */
const diffFiles = (snapshot: Files | undefined) => {
  if (snapshot === undefined) return noFiles;
  let files = converted.get(snapshot);
  if (!files) {
    files = orderDiffFiles(toDiffFiles(snapshot.files));
    converted.set(snapshot, files);
  }
  return files;
};

export function PullRequestFiles({ detail }: { detail: PullRequestDetail }) {
  const query = useQuery(
    pullRequestFilesQuery(detail.key, detail.accountId, detail.headSha, detail.baseSha),
  );
  const client = useQueryClient();
  const { showTree, toggleTree } = usePrViewStore();
  const [activePath, setActivePath] = useState<string>();
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<DiffListHandle>(null);
  const files = diffFiles(query.data);
  // Drafts and threads load with the files, so comments never push the diff down later.
  const pending = useQuery(pendingCommentsQuery(detail.key, detail.accountId));
  const threads = useQuery(reviewThreadsQuery(detail.key, detail.accountId));
  // Marks load with the files too, so a reviewed file never opens and then folds.
  const reviewed = useReviewedFiles(detail.key, detail.accountId);
  useReviewedKey(root, reviewed.status === "ready" ? "[data-file-diff-card]" : null);
  const [filter, setFilter] = useFilesFilter(detail.key);
  const revealTree = useCallback(() => {
    const view = usePrViewStore.getState();
    if (!view.showTree) view.toggleTree();
  }, []);
  const filterRequest = useFilterKey(root, revealTree);
  const notesShown = useGuideNotesOnFiles();
  const writing = useReviewCommentsStore(writingOn(detail));
  const guideNotes = useFilesGuideNotes(detail, query.data, notesShown.shown, writing);
  const notes = guideNotes._tag === "ready" ? guideNotes.notes : null;
  const commentsFor = useDiffComments(detail, files, {
    commitSha: query.data?.headSha ?? detail.headSha,
    threads: true,
    outdated: true,
    notes: { on: "files", notes },
  });
  // Notes that come with the first paint never push a diff down; ones turned on later say so
  // above the list instead.
  const [painted, setPainted] = useState(false);
  const waiting =
    query.isPending ||
    pending.isPending ||
    threads.isPending ||
    reviewed.status === "pending" ||
    notesShown.pending ||
    (query.isSuccess && !painted && guideNotes._tag === "loading");
  if (query.isSuccess && !waiting && !painted) setPainted(true);
  useLayoutEffect(() => {
    const viewport = root.current?.closest<HTMLDivElement>("[data-pr-scroll]");
    if (viewport && painted) viewport.scrollTop = readViewMemory(detail.key)?.scroll.files ?? 0;
  }, [detail.key, painted]);
  if (waiting)
    return (
      <div aria-busy="true" aria-label="Loading files" className="space-y-4 p-4">
        <Skeleton className="h-7 w-64" />
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="space-y-3">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        ))}
      </div>
    );
  if (query.isError)
    return (
      <div className="p-4">
        <ListError
          title="Couldn't load changed files"
          message={query.error.message}
          retry={() => void query.refetch()}
        />
      </div>
    );
  const snapshot = query.data;
  const loadContents: LoadContents = async (file) => {
    const [oldFile, newFile] = await Promise.all([
      client.fetchQuery(
        pullRequestFileContentsQuery(
          detail.key,
          detail.accountId,
          file.path,
          "old",
          snapshot.headSha,
          snapshot.baseSha,
        ),
      ),
      client.fetchQuery(
        pullRequestFileContentsQuery(
          detail.key,
          detail.accountId,
          file.path,
          "new",
          snapshot.headSha,
          snapshot.baseSha,
        ),
      ),
    ]);
    if (newFile.sha !== snapshot.headSha)
      throw new Error(
        "This pull request changed. Refresh its files before expanding unchanged lines.",
      );
    return { oldContents: oldFile.content, newContents: newFile.content };
  };
  // The list opens a folded card, keeps it aligned while diffs above it draw, and focuses it,
  // so `r` ticks the file just opened.
  const open = (path: string) => {
    setActivePath(path);
    list.current?.goTo({ path, range: null });
  };
  return (
    <div data-pr-files="" className="flex min-h-0 flex-col" ref={root}>
      <TabActions>
        <ReviewedCount reviewed={reviewed} files={files} />
        <DiffControls />
        {guideNotes._tag !== "none" && (
          <ToolbarIconButton
            label={notesShown.shown ? "Hide guide notes" : "Show guide notes"}
            pressed={notesShown.shown}
            disabled={notesShown.saving}
            onClick={() => notesShown.set(!notesShown.shown)}
          >
            <BookOpenTextIcon />
          </ToolbarIconButton>
        )}
        <ToolbarIconButton
          label={showTree ? "Hide file tree" : "Show file tree"}
          pressed={showTree}
          onClick={toggleTree}
        >
          <FolderTreeIcon />
        </ToolbarIconButton>
      </TabActions>
      <ReviewCommentsAlerts pr={detail} />
      <FilesGuideNotesStatus state={guideNotes} />
      <CommentsWithoutDiff pr={detail} files={files} />
      {snapshot.changedFiles > files.length && (
        <p
          role="status"
          className="border-b border-warning/30 bg-warning-surface px-4 py-2 text-xs text-warning-foreground"
        >
          GitHub returned {files.length} of {snapshot.changedFiles} changed files.{" "}
          <a href={`${detail.url}/files`} target="_blank" rel="noreferrer" className="underline">
            Open all files on GitHub
          </a>
          .
        </p>
      )}
      {files.length === 0 ? (
        <div role="status" className="px-4 py-16 text-center">
          <h2 className="text-sm font-medium">No changed files</h2>
          <p className="mt-2 text-xs text-muted-foreground">
            This pull request has no file changes.
          </p>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 items-start">
          <div data-pr-files-scroll="" className="min-w-0 flex-1">
            <DiffList
              ref={list}
              files={files}
              source={{
                _tag: "pullRequest",
                key: detail.key,
                accountId: detail.accountId,
                sha: snapshot.headSha,
              }}
            >
              {files.map((file, index) => (
                <FileDiffCard
                  // A new version of a file is a new card, so a file reviewed before a push
                  // opens as changed; one whose hunks only moved keeps how the user left it.
                  key={`${snapshot.baseSha}:${file.path}:${versionOf(file)?.hunks ?? versionOf(file)?.end ?? ""}`}
                  file={file}
                  id={`pr-file-${index}`}
                  loadContents={loadContents}
                  prUrl={detail.url}
                  interaction={commentsFor(file)}
                  annotations={notes?.files.get(file.path)?.annotations ?? noNotes}
                  note={notes?.files.get(file.path)?.note ?? null}
                  fromGuide
                  reviewed={
                    reviewed.status === "ready"
                      ? {
                          state: reviewed.stateOf(file),
                          onChange: (next) => reviewed.set([file], next),
                        }
                      : undefined
                  }
                />
              ))}
            </DiffList>
          </div>
          {showTree && (
            <aside
              data-pr-files-tree=""
              className="w-[min(20rem,40%)] min-w-36 shrink-0 overflow-auto border-l border-border/60 bg-background"
            >
              <FilesTreePanel
                files={files}
                stateOf={reviewed.status === "ready" ? reviewed.stateOf : null}
                filter={filter}
                onFilter={setFilter}
                activePath={activePath}
                onOpen={open}
                focusRequest={filterRequest}
              />
            </aside>
          )}
        </div>
      )}
    </div>
  );
}
