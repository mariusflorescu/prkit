const appleTerminal = { bundleId: "com.apple.Terminal", name: "Terminal" };

/**
 * Terminals that run an executable they're asked to open, in the user's own shell, as a double
 * click in Finder does. Ghostty, iTerm2 and kitty ask before they run it. Alacritty can't open
 * files, and Warp is closed source, so what it does with one is unknown.
 */
const terminals = [
  appleTerminal,
  { bundleId: "com.mitchellh.ghostty", name: "Ghostty" },
  { bundleId: "com.googlecode.iterm2", name: "iTerm2" },
  { bundleId: "com.github.wez.wezterm", name: "WezTerm" },
  { bundleId: "net.kovidgoyal.kitty", name: "kitty" },
];

/**
 * JavaScript for `osascript` that prints the app macOS runs executables with. macOS has no other
 * default terminal: Ghostty's "Make Ghostty the Default Terminal" and iTerm2's "Make iTerm2
 * Default Term" both change this one.
 */
export const defaultTerminalScript =
  'ObjC.import("CoreServices"); ObjC.unwrap(ObjC.castRefToObject($.LSCopyDefaultRoleHandlerForContentType($("public.unix-executable"), $.kLSRolesShell)))';

export const terminalsToTry = (defaultBundleId: string) => {
  // Launch Services ignores case, and iTerm2 stores Terminal as com.apple.terminal.
  const id = defaultBundleId.trim().toLowerCase();
  const known = terminals.find((terminal) => terminal.bundleId.toLowerCase() === id);
  if (known === appleTerminal) return [{ ...appleTerminal, isDefault: true }];
  return [
    ...(known === undefined ? [] : [{ ...known, isDefault: true }]),
    { ...appleTerminal, isDefault: false },
  ];
};
