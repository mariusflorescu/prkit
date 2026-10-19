# Settings > Appearance

Three cards, System, Light and Dark, each a miniature of prkit in that theme (System is split in half). Picking one applies at once and is stored by the server, so it survives a relaunch even when the server's port changes. System follows the OS live. In Electron the choice also drives the title bar, menus and Dock icon, and the window opens in it with no flash of the other theme. How it works: [docs/internals/appearance.md](../../../../docs/internals/appearance.md).

## Sub-features

- `theme-cards` is `radiogroup "Theme"` with `radio "System"`, `radio "Light"` and `radio "Dark"`.
- `theme-instant` puts `html.dark` and `html[data-theme]` in the same frame as the click.
- `theme-stored` is `settings.appearance.theme` in `<home>/prkit.sqlite`, a JSON string (`"dark"`).
- `theme-first-paint` paints the stored theme before React: the server's `/appearance.js` sets `data-theme`, index.html sets `html.dark`.
- `theme-system-live` follows the OS while the page is open.
- `theme-failed-save` keeps the cards on what prkit holds when a pick fails to save, with the error and Retry below them; while a pick saves, the cards are dimmed and take no other. See Failed saves in [Settings](./settings.md).
- `theme-desktop` sets `nativeTheme.themeSource` before the first window, on every change, and swaps the Dock icon.

## How to get to it (user POV)

- Cmd+, then Appearance in the section list, or `<url>/settings/appearance`.

## Driving it with e2e

Preconditions:

- `pnpm build` ran after the last change. Never change the machine's appearance: read it with `defaults read -g AppleInterfaceStyle` (prints `Dark`, or an error when Light) and choose the opposite.

- **Browser.** `tests/settings.e2e.ts` replaces `matchMedia` before the page loads (`tests/osColorScheme.ts`), so the OS is light, then dark, without touching macOS. Dark with a light OS: `html.dark`, `data-theme="dark"`, and `settings.appearance.theme = '"dark"'`. With the app's entry script blocked (`browser.route("**/assets/index-*.js", abort)`) a reload still paints the dark splash (the frame's `rgb(21, 17, 13)`), so first paint comes from the server. System follows `setOsColorScheme` both ways. Light with a dark OS stays light, also on the splash. It saves `appearance-*` and `boot-splash-*` frames.
- **Desktop.** `pnpm smoke:desktop` checks `prkitDesktop.setTheme("dark")` moves `nativeTheme.themeSource` and that an unknown theme is ignored. For the rest, write a script under `.e2e/scripts/` that launches the built app with `colorScheme: null`, `PRKIT_HOME` and `--user-data-dir` under `.e2e/`: choose the theme opposite to macOS, quit, relaunch with `recordVideo`, and check `nativeTheme.themeSource`, `BrowserWindow.getBackgroundColor()` (`#15110D` and `#F2EEE9`, the frame's dark and light) and `html.dark`. Per-frame luma of the recording (`ffmpeg -vf signalstats`) shows whether any frame is the other theme. Spy `app.dock.setIcon` to see `prkit-icon-macos-<theme>-1024.png` on a switch.
- **System in Electron.** `Emulation.setEmulatedMedia` over CDP changes `prefers-color-scheme` without touching macOS; `html.dark` follows both ways. The native half (Dock icon on a real macOS change) is `nativeTheme.on("updated")` in `branding.ts`; check it by hand, looking at the Dock while switching System Settings > Appearance.

## Gotchas

- Playwright's Electron launch emulates a light page by default. Pass `colorScheme: null` or the page never follows `nativeTheme`.
- The radio inputs are visually hidden; tap the card's text (`theme.getByText("Dark")`), then assert `radio "Dark"` is checked.
- A reload resets the remembered Settings section but not the theme.
