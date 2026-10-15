import type { AgentInstanceId } from "@prkit/contracts";

import { Button } from "~/components/ui/button";

import { useAgentSignIn } from "./useAgentSignIn";

/**
 * Signs an agent in for prkit in the browser, when the user's own login can't be shared:
 * the button, then the page to finish on with Cancel, or why it failed with Try again.
 */
export function AgentSignIn({ instance }: { instance: AgentInstanceId }) {
  const { state, start, cancel } = useAgentSignIn(instance);
  switch (state._tag) {
    case "idle":
      return (
        <Button size="xs" onClick={start}>
          Sign in for prkit
        </Button>
      );
    case "opening":
      return (
        <Button size="xs" disabled>
          Opening the sign-in page…
        </Button>
      );
    case "browser":
      return (
        <span
          role="status"
          aria-label="Signing in for prkit"
          className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
        >
          Continue in your browser to finish signing in.
          <a href={state.url} target="_blank" rel="noreferrer" className="underline">
            Open the sign-in page
          </a>
          <Button size="xs" variant="ghost-muted" onClick={cancel}>
            Cancel
          </Button>
        </span>
      );
    case "checking":
      return (
        <Button size="xs" disabled>
          Checking the new sign-in…
        </Button>
      );
    case "failed":
      return (
        <span
          role="alert"
          className="flex flex-wrap items-center gap-2 text-xs text-error-foreground"
        >
          {state.message}
          <Button size="xs" variant="outline" onClick={start}>
            Try again
          </Button>
        </span>
      );
  }
}
