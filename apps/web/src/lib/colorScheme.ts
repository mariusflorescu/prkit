import { ThemePreference } from "@prkit/contracts";
import * as Schema from "effect/Schema";

const isTheme = Schema.is(ThemePreference);
const systemDark = window.matchMedia("(prefers-color-scheme: dark)");
let stopFollowing = () => {};

/** The choice index.html found on `<html data-theme>`, from the server's stored setting. */
export const bootTheme = (): ThemePreference => {
  const stored = document.documentElement.dataset.theme;
  return isTheme(stored) ? stored : "system";
};

const paint = (dark: boolean) => {
  const root = document.documentElement;
  if (root.classList.contains("dark") === dark) return;
  root.classList.add("no-transitions");
  root.classList.toggle("dark", dark);
  void root.offsetHeight;
  requestAnimationFrame(() => root.classList.remove("no-transitions"));
};

/**
 * Puts the chosen theme on `<html class="dark">`, which the theme tokens key on. `system` keeps
 * following the OS until the next call. Calling it again with the same choice changes nothing.
 */
export function applyTheme(theme: ThemePreference): void {
  stopFollowing();
  document.documentElement.dataset.theme = theme;
  if (theme !== "system") {
    stopFollowing = () => {};
    paint(theme === "dark");
    return;
  }
  const follow = () => paint(systemDark.matches);
  follow();
  systemDark.addEventListener("change", follow);
  stopFollowing = () => systemDark.removeEventListener("change", follow);
}
