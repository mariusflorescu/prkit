import type { AgentCatalogEntry } from "@prkit/contracts";

import { AgentSignIn } from "~/components/review/agent/AgentSignIn";
import { ProviderIcon } from "~/components/review/agent/ProviderIcon";

import { FixCommand } from "./FixCommand";
import { ProviderSignOut } from "./ProviderSignOut";

/** One agent's sign-in: the login it runs on, or why it can't write guides and what fixes that. */
export function ProviderStatusRow({ provider }: { provider: AgentCatalogEntry }) {
  const state = provider.state;
  return (
    <li className="flex items-start gap-3 border-b border-border/60 py-4">
      <ProviderIcon kind={provider.kind} className="mt-0.5 size-5" />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-sm">{provider.label}</span>
          <span
            className={
              state._tag === "ready"
                ? "text-xs text-success-foreground"
                : "text-xs text-error-foreground"
            }
          >
            {state._tag === "ready" ? "Ready" : "Not ready"}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          {state._tag === "ready" ? state.detail : state.message}
        </p>
        {state._tag === "unavailable" && state.reason === "keychain-login" && (
          <div className="pt-1">
            <AgentSignIn provider={provider.kind} />
          </div>
        )}
        {state._tag === "unavailable" && state.fix !== null && (
          <>
            <p className="pt-1 text-xs text-muted-foreground">
              {state.reason === "keychain-login"
                ? "Or run this in a terminal, then check again:"
                : "Run this in a terminal, then check again:"}
            </p>
            <FixCommand command={state.fix} />
          </>
        )}
        {state.ownLogin && <ProviderSignOut provider={provider.kind} />}
      </div>
    </li>
  );
}
