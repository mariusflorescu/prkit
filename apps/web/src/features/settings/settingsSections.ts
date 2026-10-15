import {
  ArrowDownToLineIcon,
  BookOpenTextIcon,
  BotIcon,
  CircleUserRoundIcon,
  InfoIcon,
  KeyboardIcon,
  PaletteIcon,
  PlugIcon,
} from "lucide-react";

import { updatesBridge } from "~/lib/desktop";

/** Every Settings section, in nav order. The router, the nav and "open where I left off" read this. */
export const SETTINGS_SECTIONS = [
  { id: "accounts", to: "/settings/accounts", label: "Accounts", icon: CircleUserRoundIcon },
  { id: "agents", to: "/settings/agents", label: "Agents", icon: BotIcon },
  { id: "guides", to: "/settings/guides", label: "Guides", icon: BookOpenTextIcon },
  {
    id: "outside-agents",
    to: "/settings/outside-agents",
    label: "Outside agents",
    icon: PlugIcon,
  },
  { id: "appearance", to: "/settings/appearance", label: "Appearance", icon: PaletteIcon },
  { id: "shortcuts", to: "/settings/shortcuts", label: "Keyboard shortcuts", icon: KeyboardIcon },
  { id: "updates", to: "/settings/updates", label: "Updates", icon: ArrowDownToLineIcon },
  { id: "about", to: "/settings/about", label: "About", icon: InfoIcon },
] as const;

/** The sections this window shows: Updates only in the desktop app. */
export const VISIBLE_SETTINGS_SECTIONS = SETTINGS_SECTIONS.filter(
  (section) => section.id !== "updates" || updatesBridge !== undefined,
);

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

export const FIRST_SETTINGS_SECTION = SETTINGS_SECTIONS[0];

export const isSettingsPath = (pathname: string) =>
  pathname === "/settings" || pathname.startsWith("/settings/");

export const settingsSectionAt = (pathname: string) =>
  VISIBLE_SETTINGS_SECTIONS.find((section) => pathname === section.to);
