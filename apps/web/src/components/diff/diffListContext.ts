import type { DiffFile } from "@prkit/contracts";
import { createContext, useCallback, useContext, useSyncExternalStore } from "react";

import { noMoves, type FileMoves } from "./moves";
import { fileScopes } from "./scope";
import type { LineRange, RevealLines } from "./types";

type Jump = { readonly path: string; readonly reveal: RevealLines };

/**
 * What reaches a list's files after it rendered: the new side read for their scope lines,
 * and a jump to one of them. Each card hears only about its own file, so a read answer
 * or a jump renders the few cards it changes, never the whole list again.
 */
export function makeLiveFiles() {
  let files: ReadonlyMap<string, DiffFile> = new Map();
  let texts: ReadonlyMap<string, string> = new Map();
  let jump: Jump | null = null;
  const listeners = new Map<string, Set<() => void>>();
  return {
    reveal: (path: string) => (jump?.path === path ? jump.reveal : null),
    scopes: (path: string) => {
      const file = files.get(path);
      const text = texts.get(path);
      return file === undefined || text === undefined ? null : fileScopes(file, text);
    },
    subscribe: (path: string, listener: () => void) => {
      const heard = listeners.get(path) ?? new Set();
      listeners.set(path, heard);
      heard.add(listener);
      return () => {
        heard.delete(listener);
        if (heard.size === 0) listeners.delete(path);
      };
    },
    publish: (next: {
      files: ReadonlyMap<string, DiffFile>;
      texts: ReadonlyMap<string, string>;
      jump: Jump | null;
    }) => {
      const changed = new Set<string>();
      if (next.files !== files) for (const path of next.files.keys()) changed.add(path);
      for (const [path, text] of next.texts) if (texts.get(path) !== text) changed.add(path);
      for (const path of texts.keys()) if (!next.texts.has(path)) changed.add(path);
      if (next.jump !== jump) {
        if (jump) changed.add(jump.path);
        if (next.jump) changed.add(next.jump.path);
      }
      ({ files, texts, jump } = next);
      for (const path of changed) for (const listener of listeners.get(path) ?? []) listener();
    },
  };
}
export type LiveFiles = ReturnType<typeof makeLiveFiles>;

export type DiffListValue = {
  /**
   * Shows the lines: opens their card, mounts its diff, scrolls them to the middle and
   * highlights them. A null range opens the card and scrolls to its top.
   */
  goTo: (target: { path: string; range: LineRange | null }) => void;
  /** Whether some place in this list can show the path's card. */
  reachable: (path: string) => boolean;
  moves: ReadonlyMap<string, FileMoves>;
  live: LiveFiles;
};

/** What a list's owner can ask of it from outside, such as a guide's links to a line. */
export type DiffListHandle = Pick<DiffListValue, "goTo">;

const noList: DiffListValue = {
  goTo: () => {},
  reachable: () => false,
  moves: new Map(),
  live: makeLiveFiles(),
};

export const DiffListContext = createContext(noList);

export function useDiffList() {
  const { goTo, reachable } = useContext(DiffListContext);
  return { goTo, reachable };
}

const useLive = <A>(path: string, read: (live: LiveFiles, path: string) => A) => {
  const { live } = useContext(DiffListContext);
  const subscribe = useCallback(
    (listener: () => void) => live.subscribe(path, listener),
    [live, path],
  );
  return useSyncExternalStore(subscribe, () => read(live, path));
};

export const useFileMoves = (path: string) =>
  useContext(DiffListContext).moves.get(path) ?? noMoves;
/** A jump to this file's lines, or null. */
export const useFileReveal = (path: string) => useLive(path, (live, at) => live.reveal(at));
/** The file's scope chains once its new side was read, null until then and when it can't be. */
export const useFileScopes = (path: string) => useLive(path, (live, at) => live.scopes(at));
