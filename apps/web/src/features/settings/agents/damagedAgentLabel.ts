import { AGENT_KIND_NAMES, type DamagedAgent } from "@prkit/contracts";

/** What a setting prkit can't read is called: its kind for a default, else its ID. */
export const damagedAgentLabel = (damaged: DamagedAgent) =>
  damaged.isDefault && damaged.kind !== null
    ? AGENT_KIND_NAMES[damaged.kind].short
    : damaged.instance;
