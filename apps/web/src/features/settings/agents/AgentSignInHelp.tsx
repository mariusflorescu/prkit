import type { AgentCatalogEntry } from "@prkit/contracts";

import { AgentSignIn } from "~/components/review/agent/AgentSignIn";

import { CursorInstall } from "./CursorInstall";
import { CursorSignIn } from "./CursorSignIn";
import { FixCommand } from "./FixCommand";
import { ProviderSignOut } from "./ProviderSignOut";

/**
 * How to sign this instance in: prkit's own sign-in in the browser where it holds the login,
 * and the exact terminal command for this instance's binary and folder. Cursor has no terminal
 * command: its support installs from here, and it signs in from here or with a key in Edit.
 */
export function AgentSignInHelp({ entry }: { entry: AgentCatalogEntry }) {
  const state = entry.state;
  if (!entry.enabled) return null;
  if (entry.kind === "cursor")
    return (
      <>
        {state._tag === "unavailable" && state.reason === "not-installed" && <CursorInstall />}
        {state._tag === "unavailable" && state.reason === "logged-out" && (
          <CursorSignIn instance={entry.instance} />
        )}
        {state.ownLogin && <ProviderSignOut instance={entry.instance} />}
      </>
    );
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
