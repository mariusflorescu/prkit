import {
  WorkerPoolContextProvider,
  type WorkerInitializationRenderOptions,
  type WorkerPoolOptions,
} from "@pierre/diffs/react";
import DiffsWorker from "@pierre/diffs/worker/worker.js?worker";
import type { ReactNode } from "react";

export const DIFF_THEMES = { light: "pierre-light", dark: "pierre-dark" } as const;

const poolOptions: WorkerPoolOptions = {
  workerFactory: () => new DiffsWorker(),
  poolSize: Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 4) - 1)),
  totalASTLRUCacheSize: 120,
};
const highlighterOptions: WorkerInitializationRenderOptions = {
  theme: DIFF_THEMES,
  lineDiffType: "word-alt",
  // The JS regex engine can backtrack indefinitely on source text.
  preferredHighlighter: "shiki-wasm",
  tokenizeMaxLineLength: 1000,
};

export function DiffWorkerPoolProvider({ children }: { children: ReactNode }) {
  return (
    <WorkerPoolContextProvider poolOptions={poolOptions} highlighterOptions={highlighterOptions}>
      {children}
    </WorkerPoolContextProvider>
  );
}
