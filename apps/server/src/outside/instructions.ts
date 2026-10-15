/** The outside endpoint's `instructions`: what prkit is, what its tools do, and what stays a click. */
export const OUTSIDE_INSTRUCTIONS =
  "prkit is the owner's local app for reviewing GitHub pull requests. These tools read what is waiting in prkit's inbox, open a pull request in the app, start and read a guided review (a guide) written by the owner's agent in prkit, add review comments as local drafts, and send them to prkit's fix agent, which commits fixes locally. Name a pull request by its URL or by host, owner, repo and number; prkit reads it through the GitHub account whose inbox has it, or the only one on its host. Guides and fixes take minutes: start one, then call wait_for and read it. Nothing here reaches GitHub. Pushing, merging, posting a review, and replying to or resolving threads happen in the prkit app, by the owner.";

/** What a client hears from the bridge while prkit can't answer. */
export const OUTSIDE_OFFLINE_INSTRUCTIONS =
  "prkit is the owner's local app for reviewing GitHub pull requests. It isn't reachable right now: it isn't open, or Outside agents are off in its Settings. Its tools appear once it is.";
