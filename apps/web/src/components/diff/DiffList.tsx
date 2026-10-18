import { DIFF_TEXT_BATCH, type DiffFile, type DiffSource, type DiffTexts } from "@prkit/contracts";
import { useQueries, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";

import { Button } from "~/components/ui/button";
import { diffTextsQuery } from "~/rpc/queries";

import { DiffWorkerPoolProvider } from "./DiffWorkerPoolProvider";
import { alignScroll, scrollParent } from "./alignScroll";
import {
  DiffListContext,
  makeLiveFiles,
  type DiffListHandle,
  type DiffListValue,
} from "./diffListContext";
import { movesOf } from "./moves";
import { needsText } from "./scope";
import type { LineRange, RevealLines } from "./types";
import "./diff.css";

const batched = new WeakMap<ReadonlyArray<DiffFile>, ReadonlyArray<ReadonlyArray<string>>>();
/** The paths whose new side the scope lines need, in reading order, one read per batch. */
const batchesOf = (files: ReadonlyArray<DiffFile>) => {
  let known = batched.get(files);
  if (!known) {
    const paths = files.filter(needsText).map((file) => file.path);
    known = Array.from({ length: Math.ceil(paths.length / DIFF_TEXT_BATCH) }, (_, index) =>
      paths.slice(index * DIFF_TEXT_BATCH, (index + 1) * DIFF_TEXT_BATCH),
    );
    batched.set(files, known);
  }
  return known;
};

const combineTexts = (results: Array<UseQueryResult<DiffTexts>>) => ({
  answers: results.map((result) => result.data ?? null),
  failed: results.map((result) => result.isError),
  message: results.find((result) => result.isError)?.error?.message ?? null,
});

const stay = () => {};

/**
 * One diff's files, however many places show them: finds the moves between them, reads
 * their new side for the scope lines, and takes the list's cards to any line.
 */
export function DiffList({
  files,
  source,
  locate,
  ref,
  children,
}: {
  /** The whole diff, also when a place shows only some of it. */
  files: ReadonlyArray<DiffFile>;
  /** The commit the new side is read at; null reads nothing, moves still show. */
  source: DiffSource | null;
  /** Makes a path's card show, or null when no place can. Default: every file is in the list. */
  locate?: ((path: string) => (() => void) | null) | undefined;
  ref?: Ref<DiffListHandle> | undefined;
  children: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const client = useQueryClient();
  const batches = source === null ? [] : batchesOf(files);
  // The first diffs paint before any text arrives to be decoded; the scope lines fill rows
  // that are already there. Texts read before, such as a PR opened again, show at once.
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    const handle = window.requestIdleCallback(() => setIdle(true), { timeout: 2000 });
    return () => window.cancelIdleCallback(handle);
  }, []);
  const reading =
    idle ||
    batches.every(
      (batch) =>
        source !== null &&
        client.getQueryData(diffTextsQuery(source, batch).queryKey) !== undefined,
    );
  const reads = useQueries({
    queries:
      source === null || !reading ? [] : batches.map((batch) => diffTextsQuery(source, batch)),
    combine: combineTexts,
  });
  const { answers, failed, message } = reads;
  const paths = useMemo(() => new Set(files.map((file) => file.path)), [files]);
  const opener = useCallback(
    (path: string) => (locate ? locate(path) : paths.has(path) ? stay : null),
    [locate, paths],
  );
  const [jump, setJump] = useState<{ path: string; reveal: RevealLines } | null>(null);
  const stopAligning = useRef<(() => void) | null>(null);
  const goTo = useCallback(
    ({ path, range }: { path: string; range: LineRange | null }) => {
      const open = opener(path);
      const list = root.current;
      const viewport = list && scrollParent(list);
      if (open === null || !list || !viewport) return;
      open();
      let cell: HTMLElement | null = null;
      const aligned = alignScroll(viewport, list, () => {
        const card = list.querySelector<HTMLElement>(
          `[data-file-diff-card][data-path="${CSS.escape(path)}"]`,
        );
        if (!card) return null;
        return cell?.isConnected
          ? { element: cell, block: "center", focus: card }
          : { element: card, block: "start", focus: card };
      });
      stopAligning.current = aligned.stop;
      const onCell = (found: HTMLElement) => {
        cell = found;
        aligned.realign();
      };
      setJump({ path, reveal: range === null ? { range } : { range, onCell } });
    },
    [opener],
  );
  const reachable = useCallback((path: string) => opener(path) !== null, [opener]);
  useImperativeHandle(ref, () => ({ goTo }), [goTo]);
  useEffect(() => () => stopAligning.current?.(), []);
  const [live] = useState(makeLiveFiles);
  const texts = useMemo(() => {
    const read = new Map<string, string>();
    for (const answer of answers)
      for (const entry of answer?.files ?? [])
        if (entry.text._tag === "text") read.set(entry.path, entry.text.content);
    return read;
  }, [answers]);
  const byPath = useMemo(() => new Map(files.map((file) => [file.path, file])), [files]);
  // After the cards rendered, so a long list renders once and then only the files that changed.
  useLayoutEffect(() => live.publish({ files: byPath, texts, jump }), [live, byPath, texts, jump]);
  const moves = movesOf(files);
  const value = useMemo<DiffListValue>(
    () => ({ goTo, reachable, moves, live }),
    [goTo, reachable, moves, live],
  );
  const retry = () => {
    if (source === null) return;
    batches.forEach((batch, index) => {
      if (failed[index])
        void client.refetchQueries({
          queryKey: diffTextsQuery(source, batch).queryKey,
          exact: true,
        });
    });
  };
  return (
    <DiffWorkerPoolProvider>
      <DiffListContext value={value}>
        <div ref={root} data-diff-list="">
          {message !== null && (
            <div data-diff-list-status="" role="alert">
              <p>Couldn't read the code around each change. {message}</p>
              <Button size="compact" variant="outline" onClick={retry}>
                Retry
              </Button>
            </div>
          )}
          {children}
        </div>
      </DiffListContext>
    </DiffWorkerPoolProvider>
  );
}
