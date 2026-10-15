import type { AgentInstanceId } from "@prkit/contracts";

import { AgentSignIn } from "~/components/review/agent/AgentSignIn";

/** Cursor's sign-in for prkit, saying first what it leaves behind in the user's Cursor account. */
export function CursorSignIn({ instance }: { instance: AgentInstanceId }) {
  return (
    <div className="space-y-2 pt-1">
      <p className="text-xs text-muted-foreground">
        Signing in creates a Cursor API key for prkit that lasts 90 days and shows in your Cursor
        dashboard. Its use is billed to your Cursor plan. Signing out later forgets the key here;
        delete it in the dashboard to end it sooner.
      </p>
      <AgentSignIn instance={instance} label="Sign in with Cursor" />
    </div>
  );
}
