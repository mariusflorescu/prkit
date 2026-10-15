import type { AgentInstanceId } from "@prkit/contracts";

import { ChatGptSignIn } from "./ChatGptSignIn";

/** Step 3 of "Sign in with ChatGPT": what happens, then the sign-in itself once the agent exists. */
export function AddAgentSignInStep({ created }: { created: AgentInstanceId | null }) {
  return (
    <div className="space-y-3 text-xs text-muted-foreground">
      <p>
        This agent gets a Codex sign-in of its own, apart from your other Codex logins. prkit opens
        the ChatGPT sign-in page in your browser: choose the account this agent should use there.
      </p>
      {created !== null && <ChatGptSignIn instance={created} />}
    </div>
  );
}
