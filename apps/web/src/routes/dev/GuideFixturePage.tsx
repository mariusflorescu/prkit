import { useLoaderData } from "@tanstack/react-router";

import { GuideView } from "~/components/guide";
import type { LoadContents } from "~/components/diff";

import { FixturePicker } from "./FixturePicker";

const unavailableContents: LoadContents = async () => null;

export function GuideFixturePage() {
  const { fixture, guide, snapshot, warnings } = useLoaderData({ from: "/dev/guide/$fixture" });
  return (
    <>
      <header className="flex min-h-[var(--workspace-topbar-height)] shrink-0 items-center justify-between gap-4 border-b border-border px-5">
        <FixturePicker selected={fixture.name} />
        <span className="text-xs text-muted-foreground">Development preview</span>
      </header>
      {warnings.length > 0 && (
        <details className="shrink-0 border-b border-border bg-warning-surface px-5 py-2 text-xs text-warning-foreground">
          <summary className="cursor-pointer">
            {warnings.length} guide warning{warnings.length === 1 ? "" : "s"}
          </summary>
          <ul className="mt-2 list-disc space-y-1 pl-4">
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </details>
      )}
      <GuideView
        key={fixture.name}
        guide={guide}
        snapshot={snapshot}
        prUrl={fixture.prUrl}
        loadContents={unavailableContents}
      />
    </>
  );
}
