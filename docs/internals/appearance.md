# Appearance

The theme (System, Light or Dark) is stored by the server, because the window's origin includes the server's port and the port can change between launches. `localStorage` would forget it. The stored value reaches the first paint of every surface without a flash of the other theme.

## Where the value lives and who reads it

- `settings` table, key `appearance.theme`, a JSON string (`"dark"`). A missing or damaged value reads as `system`. `AppearanceStore` (`apps/server/src/appearance/`) owns it; `appearance.get` and `appearance.update` are the RPCs.
- **Electron.** The server's ready line carries `theme`. Main sets `nativeTheme.themeSource` from it before it creates the window, so the window background, traffic lights, menus and the Dock icon swap (`branding.ts` listens to `nativeTheme`) all start in the stored theme. Chromium then answers `prefers-color-scheme` from `themeSource`, so the page agrees with no extra work. At runtime the page tells main through `prkitDesktop.setTheme`; main accepts only the three choices.
- **Browser.** `index.html` loads `/appearance.js` before anything paints. The server answers with one line, `document.documentElement.dataset.theme="dark";`, and the inline boot script turns that into `html.dark` (`system` asks `matchMedia`). The route needs no token because it discloses one of three words. Vite proxies it in dev. A blocking script costs one loopback request; without an answer the page follows the OS.
- **React.** `AppearanceSync` (mounted in `main.tsx`) applies the cached setting in a layout effect, so a click on a card lands in the same frame, and forwards it to the desktop bridge. `applyTheme` in `lib/colorScheme.ts` is the only code that toggles `html.dark`; for `system` it keeps listening to the OS.

## Traps

- Playwright's Electron launch emulates a light page unless `colorScheme: null` is passed, so `prefers-color-scheme` never follows `nativeTheme` in such a test.
- Never change the machine's appearance to test this. Browser journeys replace `matchMedia` before the page loads (`tests/osColorScheme.ts`); for Electron, `Emulation.setEmulatedMedia` over CDP moves the media query while `nativeTheme` stays as is.
- `applyBranding()` sets the Dock icon from the system appearance when the app starts, and `nativeTheme` corrects it once the ready line arrives. Under a chosen theme that differs from macOS the Dock shows the other icon until the server has started.
- `.no-transitions` on `<html>` holds back colour transitions for the frame of a switch, so the change is instant instead of fading.
