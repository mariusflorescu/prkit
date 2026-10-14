import { useQuery } from "@tanstack/react-query";
import { useLayoutEffect } from "react";

import { desktopBridge } from "~/lib/desktop";
import { applyTheme } from "~/lib/colorScheme";
import { appearanceQuery } from "~/rpc/queries";

/**
 * Applies the stored theme to the page and to the desktop shell. It runs before paint, so a
 * choice made in Settings lands in the same frame. index.html already painted the same value
 * before React mounted.
 */
export function AppearanceSync() {
  const theme = useQuery(appearanceQuery).data?.theme;
  useLayoutEffect(() => {
    if (theme === undefined) return;
    applyTheme(theme);
    desktopBridge?.setTheme(theme);
  }, [theme]);
  return null;
}
