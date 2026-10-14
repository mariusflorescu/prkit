/** Cmd on macOS, Ctrl elsewhere. */
export const isApplePlatform = /Mac|iPhone|iPad/.test(navigator.platform);

export interface Binding {
  /** `primary` is Cmd on macOS and Ctrl elsewhere; `control` is Ctrl everywhere. */
  readonly modifier: "primary" | "control";
  readonly shift: boolean;
  readonly trigger:
    | { readonly keys: readonly string[]; readonly label: string }
    | { readonly code: string; readonly label: string };
}

export interface Shortcut {
  readonly id: string;
  readonly label: string;
  readonly group: "General" | "Pull requests" | "Tabs";
  /** Any one of these runs it. */
  readonly bindings: readonly Binding[];
}

const key = (value: string, label = value.toUpperCase()) => ({ keys: [value], label });

/**
 * Every shortcut WorkspaceShortcuts handles, and the list in Settings > Keyboard shortcuts.
 * A shortcut exists once, here: the handler matches against `bindings` and the list shows them.
 */
export const SHORTCUTS = [
  {
    id: "settings",
    label: "Open Settings",
    group: "General",
    bindings: [{ modifier: "primary", shift: false, trigger: key(",") }],
  },
  {
    id: "palette",
    label: "Search pull requests and commands",
    group: "General",
    bindings: [{ modifier: "primary", shift: false, trigger: key("k") }],
  },
  {
    id: "openPullRequest",
    label: "Open a pull request",
    group: "Pull requests",
    bindings: [
      { modifier: "primary", shift: false, trigger: key("n") },
      { modifier: "primary", shift: false, trigger: key("t") },
    ],
  },
  {
    id: "writeGuide",
    label: "Write a guide for this pull request",
    group: "Pull requests",
    bindings: [{ modifier: "primary", shift: false, trigger: key("g") }],
  },
  {
    id: "inbox",
    label: "Go to Inbox",
    group: "Tabs",
    bindings: [{ modifier: "primary", shift: false, trigger: key("1") }],
  },
  {
    id: "selectPullRequest",
    label: "Go to the pull request in that position (Settings has no number)",
    group: "Tabs",
    bindings: [
      {
        modifier: "primary",
        shift: false,
        trigger: { keys: ["2", "3", "4", "5", "6", "7", "8", "9"], label: "2-9" },
      },
    ],
  },
  {
    id: "nextTab",
    label: "Next tab",
    group: "Tabs",
    bindings: [
      { modifier: "control", shift: false, trigger: key("tab", "Tab") },
      { modifier: "primary", shift: true, trigger: { code: "BracketRight", label: "]" } },
    ],
  },
  {
    id: "previousTab",
    label: "Previous tab",
    group: "Tabs",
    bindings: [
      { modifier: "control", shift: true, trigger: key("tab", "Tab") },
      { modifier: "primary", shift: true, trigger: { code: "BracketLeft", label: "[" } },
    ],
  },
  {
    id: "closeTab",
    label: "Close this tab",
    group: "Tabs",
    bindings: [{ modifier: "primary", shift: false, trigger: key("w") }],
  },
  {
    id: "reopenTab",
    label: "Reopen the last closed tab",
    group: "Tabs",
    bindings: [{ modifier: "primary", shift: true, trigger: key("t") }],
  },
] as const satisfies readonly Shortcut[];

export type ShortcutId = (typeof SHORTCUTS)[number]["id"];

const matchesBinding = (binding: Binding, event: KeyboardEvent) => {
  const modifierHeld =
    binding.modifier === "primary"
      ? isApplePlatform
        ? event.metaKey
        : event.ctrlKey
      : event.ctrlKey && !event.metaKey;
  if (!modifierHeld || event.shiftKey !== binding.shift) return false;
  return "keys" in binding.trigger
    ? binding.trigger.keys.includes(event.key.toLowerCase())
    : binding.trigger.code === event.code;
};

/** The shortcut this key press is, if any. */
export const shortcutFor = (event: KeyboardEvent): ShortcutId | undefined =>
  SHORTCUTS.find((shortcut) => shortcut.bindings.some((binding) => matchesBinding(binding, event)))
    ?.id;

const modifierCap = (modifier: Binding["modifier"]) => {
  if (!isApplePlatform) return ["Ctrl"];
  return [modifier === "primary" ? "⌘" : "⌃"];
};

/** The keys to press, one cap per key: ["⌘", "⇧", "T"] on macOS, ["Ctrl", "Shift", "T"] elsewhere. */
export const keycaps = (binding: Binding): string[] => [
  ...modifierCap(binding.modifier),
  ...(binding.shift ? [isApplePlatform ? "⇧" : "Shift"] : []),
  binding.trigger.label,
];

/** A binding as one string, the way a tooltip shows it: ⌘N on macOS, Ctrl+N elsewhere. */
export const bindingHint = (binding: Binding) => keycaps(binding).join(isApplePlatform ? "" : "+");

/** What to press for a shortcut, one hint per binding. */
export const shortcutHints = (id: ShortcutId) =>
  SHORTCUTS.find((shortcut) => shortcut.id === id)?.bindings.map(bindingHint) ?? [];
