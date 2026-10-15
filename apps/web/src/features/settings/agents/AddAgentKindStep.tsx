import { AGENT_KINDS, AGENT_KIND_NAMES, type AgentProviderKind } from "@prkit/contracts";

import { ProviderIcon } from "~/components/review/agent/ProviderIcon";
import { cn } from "~/lib/utils";

import type { AddAgentValues } from "./addAgentWizard";

interface Choice {
  readonly kind: AgentProviderKind;
  readonly setup: AddAgentValues["setup"];
  readonly title: string;
  readonly description: string;
}

/**
 * What each kind offers to add. Codex can also hold a ChatGPT login of its own in prkit; Cursor
 * always holds its own.
 */
const CHOICES_BY_KIND: Record<AgentProviderKind, ReadonlyArray<Choice>> = {
  claude: [
    {
      kind: "claude",
      setup: "manual",
      title: AGENT_KIND_NAMES.claude.name,
      description: "Another Claude Code config folder, signed in to another account.",
    },
  ],
  codex: [
    {
      kind: "codex",
      setup: "manual",
      title: `${AGENT_KIND_NAMES.codex.name}, set up by hand`,
      description: "Another Codex home with its own login, or another Codex binary.",
    },
    {
      kind: "codex",
      setup: "chatgpt",
      title: "Sign in with ChatGPT",
      description: "Another ChatGPT account. prkit keeps its sign-in for this agent alone.",
    },
  ],
  cursor: [
    {
      kind: "cursor",
      setup: "cursor",
      title: AGENT_KIND_NAMES.cursor.name,
      description:
        "Another Cursor account, signed in for prkit alone. Writes guides, and fixes that only edit files.",
    },
  ],
};
const CHOICES = AGENT_KINDS.flatMap((kind) => CHOICES_BY_KIND[kind]);

/** Step 1: which agent the new instance runs, and for Codex, where its login comes from. */
export function AddAgentKindStep({
  kind,
  setup,
  onChange,
}: {
  kind: AgentProviderKind;
  setup: AddAgentValues["setup"];
  onChange: (kind: AgentProviderKind, setup: AddAgentValues["setup"]) => void;
}) {
  return (
    <div role="radiogroup" aria-label="Agent" className="grid gap-2">
      {CHOICES.map((choice) => {
        const checked = choice.kind === kind && choice.setup === setup;
        return (
          <button
            key={`${choice.kind}-${choice.setup}`}
            type="button"
            role="radio"
            aria-checked={checked}
            onClick={() => onChange(choice.kind, choice.setup)}
            className={cn(
              "flex items-start gap-3 rounded-lg border p-3 text-left outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring",
              checked ? "border-primary bg-accent" : "border-border hover:bg-accent/60",
            )}
          >
            <ProviderIcon kind={choice.kind} className="mt-0.5 size-4" />
            <span className="min-w-0">
              <span className="block text-sm font-medium">{choice.title}</span>
              <span className="block text-xs text-muted-foreground">{choice.description}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
