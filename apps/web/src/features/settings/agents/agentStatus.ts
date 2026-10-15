import type { AgentCatalogEntry } from "@prkit/contracts";

export type AgentStatusTone = "ready" | "off" | "problem" | "checking";

/**
 * The one line under an instance's name, in a fixed order: Checking, Off, Not found, Not signed
 * in, Needs attention, Unavailable, Signed in · {plan}, Ready. The detail says what to do.
 */
export const agentStatus = (
  entry: AgentCatalogEntry,
  checking: boolean,
): {
  readonly headline: string;
  readonly detail: string | null;
  readonly tone: AgentStatusTone;
} => {
  if (checking) return { headline: "Checking…", detail: null, tone: "checking" };
  if (!entry.enabled)
    return {
      headline: "Off",
      detail: "Not offered when you pick an agent. Pull requests that used it move to the default.",
      tone: "off",
    };
  const state = entry.state;
  if (state._tag === "ready")
    return state.detail === ""
      ? { headline: "Ready", detail: null, tone: "ready" }
      : { headline: `Signed in · ${state.detail}`, detail: null, tone: "ready" };
  switch (state.reason) {
    case "not-installed":
      return { headline: "Not found", detail: state.message, tone: "problem" };
    case "logged-out":
    case "keychain-login":
      return { headline: "Not signed in", detail: state.message, tone: "problem" };
    case "not-subscription":
      return { headline: "Needs attention", detail: state.message, tone: "problem" };
    case "error":
    case "off":
      return { headline: "Unavailable", detail: state.message, tone: "problem" };
  }
};
