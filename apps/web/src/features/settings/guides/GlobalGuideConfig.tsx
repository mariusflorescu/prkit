import { useQuery } from "@tanstack/react-query";

import { guideScopeQuery } from "~/rpc/queries";

import { LoadProblem } from "./LoadProblem";
import { ScopeEditors } from "./ScopeEditors";
import { ScopeEditorsSkeleton } from "./ScopeEditorsSkeleton";

const GLOBAL = { _tag: "global" } as const;

/** Settings every guide starts from. */
export function GlobalGuideConfig() {
  const global = useQuery(guideScopeQuery(GLOBAL));
  return (
    <section
      aria-labelledby="guide-config-global"
      className="mt-8 space-y-4 border-t border-border/60 pt-5"
    >
      <div>
        <h3 id="guide-config-global" className="text-sm font-medium">
          What every guide skips, answers and is told
        </h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Every guide starts from these. A repository below, and each pull request in its Guide
          tab's composer, can add their own and switch these on or off; the most specific wins. A
          guide keeps the settings it was written with, and the Guide tab says when they changed.
        </p>
      </div>
      {global.isPending ? (
        <ScopeEditorsSkeleton label="Loading global guide settings" />
      ) : global.isError ? (
        <LoadProblem
          title="Couldn't load global guide settings"
          message={global.error.message}
          retry={() => void global.refetch()}
        />
      ) : (
        <ScopeEditors
          scope={GLOBAL}
          scopeLabel="Global"
          config={global.data}
          above={null}
          onReload={() => void global.refetch()}
        />
      )}
    </section>
  );
}
