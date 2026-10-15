import type { AgentCatalogEntry } from "@prkit/contracts";

import { AgentSignIn } from "~/components/review/agent/AgentSignIn";

import { FixCommand } from "./FixCommand";
import { ProviderSignOut } from "./ProviderSignOut";

/**
 * How to sign this instance in: prkit's own sign-in in the browser where it holds the login,
 * and the exact terminal command for this instance's binary and folder.
 */
export function AgentSignInHelp({ entry }: { entry: AgentCatalogEntry }) {
  const state = entry.state;
  if (!entry.enabled) return null;
  return (
    <>
      {state._tag === "unavailable" && state.reason === "keychain-login" && (
        <div className="pt-1">
          <AgentSignIn instance={entry.instance} />
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
      {state.ownLogin && <ProviderSignOut instance={entry.instance} />}
    </>
  );
}
