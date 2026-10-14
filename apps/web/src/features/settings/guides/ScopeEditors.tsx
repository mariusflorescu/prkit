import {
  type GuideConfigLayers,
  type GuideScope,
  resolveGuideConfig,
  type ScopeConfig,
} from "@prkit/contracts";

import { FocusAreasEditor } from "./FocusAreasEditor";
import { GuidanceEditor } from "./GuidanceEditor";
import { IgnoreRulesEditor } from "./IgnoreRulesEditor";

/** The three sections of one scope, with what it inherits from the scopes above it. */
export function ScopeEditors({
  scope,
  scopeLabel,
  config,
  above,
  onReload,
}: {
  scope: GuideScope;
  scopeLabel: string;
  config: ScopeConfig;
  /** The less specific scopes; null for Global. */
  above: GuideConfigLayers | null;
  onReload: () => void;
}) {
  const inherited = above === null ? null : resolveGuideConfig(above);
  return (
    <div className="space-y-6">
      <IgnoreRulesEditor
        scope={scope}
        scopeLabel={scopeLabel}
        section={config.ignore}
        inherited={inherited?.ignore ?? []}
        presets={scope._tag === "global"}
        onReload={onReload}
      />
      <FocusAreasEditor
        scope={scope}
        scopeLabel={scopeLabel}
        section={config.focus}
        inherited={inherited?.focusAreas ?? []}
        onReload={onReload}
      />
      <GuidanceEditor
        scope={scope}
        scopeLabel={scopeLabel}
        section={config.guidance}
        inherited={inherited?.guidance ?? []}
        onReload={onReload}
      />
    </div>
  );
}
