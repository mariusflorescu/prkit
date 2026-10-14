import { Link } from "@tanstack/react-router";

import { SidebarMenuButton } from "~/components/ui/sidebar";

import { VISIBLE_SETTINGS_SECTIONS, type SettingsSectionId } from "./settingsSections";

export function SettingsNav({ active }: { active: SettingsSectionId | undefined }) {
  return (
    <nav
      aria-label="Settings sections"
      className="w-56 shrink-0 overflow-y-auto border-r border-sidebar-border bg-sidebar p-2"
    >
      <ul className="flex flex-col gap-0.5">
        {VISIBLE_SETTINGS_SECTIONS.map((section) => (
          <li key={section.id}>
            <SidebarMenuButton
              isActive={section.id === active}
              render={
                <Link
                  to={section.to}
                  replace
                  aria-current={section.id === active ? "page" : undefined}
                />
              }
            >
              <section.icon />
              <span>{section.label}</span>
            </SidebarMenuButton>
          </li>
        ))}
      </ul>
    </nav>
  );
}
