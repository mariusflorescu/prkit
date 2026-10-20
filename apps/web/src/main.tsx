import "./index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { forgetMovedAccounts } from "~/features/accounts/forgetMovedAccounts";
import { AppearanceSync } from "~/features/settings/appearance/AppearanceSync";
import { applyTheme, bootTheme } from "~/lib/colorScheme";
import { isMacDesktop } from "~/lib/desktop";
import { captureSessionToken } from "~/rpc/sessionToken";

captureSessionToken();
// index.html already painted the stored theme; this keeps `system` following the OS.
applyTheme(bootTheme());
document.documentElement.classList.toggle("electron-mac", isMacDesktop);

// The router reads the location, so it loads after the token is stripped from the URL.
// The UI faces load behind the boot splash, so the first render never swaps fonts. A face
// that fails to load leaves its fallback in place rather than holding the app on the splash.
const loadFace = (font: string) => document.fonts.load(font).catch(() => []);
const [{ router }] = await Promise.all([
  import("~/router"),
  ...["400", "500", "600"].map((weight) => loadFace(`${weight} 1em "Fira Sans"`)),
  loadFace('400 1em "JetBrains Mono"'),
]);

// The server decides when GitHub is read again and tells the window what changed
// (`useGitHubEvents`); a window coming back into focus is not a reason to read.
const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false } },
});
forgetMovedAccounts(queryClient);
const rootElement = document.getElementById("root");
if (rootElement === null) throw new Error("index.html is missing #root");

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AppearanceSync />
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
