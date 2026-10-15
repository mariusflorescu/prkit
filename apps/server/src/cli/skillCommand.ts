export const SKILLS_VERSION = "1.7.2";

export const skillInstallCommand = (repository: string, ref: string) => {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) return null;
  if (ref !== "main" && !/^[a-f0-9]{40}$/.test(ref)) return null;
  return `npx skills@${SKILLS_VERSION} add https://github.com/${repository}/tree/${ref}/skills --skill prkit-cli`;
};

/** AppleScript string literals do not interpret shell quoting. Escape this boundary too. */
export const skillTerminalScript = (command: string) =>
  `tell application "Terminal"\nactivate\ndo script "${command.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"\nend tell`;
