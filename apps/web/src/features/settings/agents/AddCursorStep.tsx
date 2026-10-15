import { type AgentInstanceId, findAgentEntry } from "@prkit/contracts";
import { useQuery } from "@tanstack/react-query";

import { agentCatalogQuery } from "~/rpc/queries";

import { CursorInstall } from "./CursorInstall";
import { CursorSignIn } from "./CursorSignIn";

/**
 * Step 3 of adding Cursor: what happens, then, once the agent exists, installing Cursor support
 * if this Mac doesn't have it yet and signing in. Neither starts by itself: the sign-in creates
 * a key in the user's Cursor account, so they press it knowing that.
 */
export function AddCursorStep({ created }: { created: AgentInstanceId | null }) {
  const catalog = useQuery(agentCatalogQuery);
  const entry =
    created === null || catalog.data === undefined
      ? undefined
      : findAgentEntry(catalog.data, created);
  const state = entry?.state;
  return (
    <div className="space-y-3 text-xs text-muted-foreground">
      <p>
        This agent signs in to Cursor apart from the Cursor app, so it can use another Cursor
        account. It writes guides and fixes that only edit files: it never runs commands. You can
        give it a CURSOR_API_KEY in Edit instead of signing in.
      </p>
      {created !== null && entry === undefined && (
        <p aria-busy="true" aria-label="Loading Cursor's status">
          Checking Cursor…
        </p>
      )}
      {state?._tag === "ready" && (
        <p role="status" className="text-success-foreground">
          Signed in · {state.detail}
        </p>
      )}
      {state?._tag === "unavailable" && state.reason === "not-installed" && <CursorInstall />}
      {state?._tag === "unavailable" && state.reason === "logged-out" && created !== null && (
        <CursorSignIn instance={created} />
      )}
      {state?._tag === "unavailable" && state.reason === "error" && (
        <p role="alert" className="text-error-foreground">
          {state.message}
        </p>
      )}
    </div>
  );
}
