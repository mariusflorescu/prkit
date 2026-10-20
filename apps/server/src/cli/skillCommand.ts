import { shellQuote } from "../outside/launcher.ts";

export const SKILLS_VERSION = "1.7.2";

/** The installer's words, or null when the build metadata could hold shell input. */
export const skillInstallWords = (repository: string, ref: string) => {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) return null;
  if (ref !== "main" && !/^[a-f0-9]{40}$/.test(ref)) return null;
  return [
    "npx",
    `skills@${SKILLS_VERSION}`,
    "add",
    `https://github.com/${repository}/tree/${ref}/skills`,
    "--skill",
    "prkit-cli",
  ];
};

/**
 * The file a terminal runs. It names no path of its own, and it starts in the home folder as a new
 * terminal does, since Ghostty starts an opened file in its folder.
 */
export const skillInstallerScript = (words: ReadonlyArray<string>) =>
  ["#!/bin/sh", "cd || exit", `exec ${words.map(shellQuote).join(" ")}`, ""].join("\n");
