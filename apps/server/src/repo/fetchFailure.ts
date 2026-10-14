/** git's stderr when GitHub refused the token or git wanted to prompt for one. */
export const denied = (stderr: string) =>
  /Authentication failed|could not read Username|terminal prompts disabled|returned error: 40[13]/i.test(
    stderr,
  );

/** What a failed `git fetch` means for the user, read from git's stderr. */
export const fetchFailure = (
  stderr: string,
  context: {
    readonly login: string;
    readonly repo: string;
    /** The last refspec asked for, which names the branch when a ref is gone. */
    readonly refspec: string;
  },
): { readonly reason: "account" | "repository"; readonly message: string } => {
  if (denied(stderr))
    return {
      reason: "account",
      message: `GitHub refused ${context.login}'s token while fetching ${context.repo}. Refresh the account in Settings, then retry.`,
    };
  if (/not found/i.test(stderr) && /repository/i.test(stderr))
    return {
      reason: "repository",
      message: `${context.login} can't read ${context.repo} on GitHub. Check the account still has access, then retry.`,
    };
  if (/couldn't find remote ref/i.test(stderr))
    return {
      reason: "repository",
      message: `GitHub no longer has a branch this pull request needs (${context.refspec}). Retry once the pull request is updated.`,
    };
  // GitHub answered, but its pack lacks objects prkit asked for or needs to unpack it.
  if (/did not send all necessary objects|from promisor remote|index-pack failed/i.test(stderr))
    return {
      reason: "repository",
      message: `GitHub sent ${context.repo} without some of the files prkit asked for. Retry, and if it happens again, prkit's log has git's error.`,
    };
  return {
    reason: "repository",
    message: `Couldn't fetch ${context.repo} from GitHub. Check your connection, then retry.`,
  };
};
