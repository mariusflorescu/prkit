import {
  BookOpenTextIcon,
  BotIcon,
  CircleUserRoundIcon,
  InfoIcon,
  KeyboardIcon,
  PaletteIcon,
} from "lucide-react";

/** Every Settings section, in nav order. The router, the nav and "open where I left off" read this. */
export const SETTINGS_SECTIONS = [
  { id: "accounts", to: "/settings/accounts", label: "Accounts", icon: CircleUserRoundIcon },
  { id: "agents", to: "/settings/agents", label: "Agents", icon: BotIcon },
  { id: "guides", to: "/settings/guides", label: "Guides", icon: BookOpenTextIcon },
  { id: "appearance", to: "/settings/appearance", label: "Appearance", icon: PaletteIcon },
  { id: "shortcuts", to: "/settings/shortcuts", label: "Keyboard shortcuts", icon: KeyboardIcon },
  { id: "about", to: "/settings/about", label: "About", icon: InfoIcon },
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

export const FIRST_SETTINGS_SECTION = SETTINGS_SECTIONS[0];

export const isSettingsPath = (pathname: string) =>
  pathname === "/settings" || pathname.startsWith("/settings/");

export const settingsSectionAt = (pathname: string) =>
  SETTINGS_SECTIONS.find((section) => pathname === section.to);
