import type { PullRequestKey } from "@prkit/contracts";

/** The open guide setup of each PR, so Cmd+G submits what the user picked there. */
const submitters = new Map<PullRequestKey, () => void>();

export const registerComposer = (key: PullRequestKey, submit: () => void) => {
  submitters.set(key, submit);
  return () => {
    if (submitters.get(key) === submit) submitters.delete(key);
  };
};

export const composerFor = (key: PullRequestKey) => submitters.get(key);
