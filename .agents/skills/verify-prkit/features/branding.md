# Branding

prkit wears the brand kit in `assets/brand/`: warm paper and ink neutrals, the rose accent, Fira Sans for the UI and JetBrains Mono for code, all served by prkit itself with no font CDN. Before React mounts, index.html paints the prkit mark on the window frame's color (`#F2EEE9` light, `#15110D` dark), the color the Electron window also opens in. Settings ends with an About section that shows prkit. The Inbox shows the mark when there are no pull requests at all. The title bar carries the mark with its wordmark over a still rose wash in the top-left corner, tuned separately for paper and ink so the rose chevron keeps at least 3:1 contrast at the wash's brightest point. In Electron on macOS, the Dock icon switches between the kit's light and dark icons with the chosen theme (System follows the system appearance, see [Settings > Appearance](./settings-appearance.md)), and the About panel names prkit with its version and tagline.

## Sub-features

- `boot-splash` shows the mark on the frame's light or dark color before the app's script runs.
- `favicon` serves `/favicon.svg`, `/favicon.ico` and `/apple-touch-icon.png` straight from `assets/brand/favicon`.
- `fonts-local` loads Fira Sans 400, 400 italic, 500 and 600 and JetBrains Mono 400 from `<url>/assets/`, never from another origin.
- `settings-about` shows the logo, the tagline, the server version and the build id in Settings > About.
- `empty-mark` shows the mark in the Inbox empty state when there are no pull requests at all.
- `titlebar-mark` puts the mark with its wordmark at the start of the title bar, over a still rose wash (`TitleBarBackdrop`) tuned for paper and ink.
- `dock-icon` follows the macOS appearance in Electron.
- `about-panel` is the macOS app menu's About prkit.
- `icns` is `apps/desktop/build/icon.icns`, rebuilt by `pnpm --filter @prkit/desktop icon`.

## How to get to it (user POV)

- Open the run's `openUrl`; the splash shows while the app's script loads.
- Press Cmd+, (or the macOS menu prkit > Settings…) and choose About in the section list.
- Start prkit with no gh accounts to see the empty Inbox.
- Look at the title bar's top-left corner, next to the macOS traffic lights in Electron.
- In the desktop app, open prkit > About prkit, and look at the Dock while switching System Settings > Appearance.

## Driving it with e2e

Preconditions:

- `pnpm build` ran after the last change. Signed in through `openUrl` (see [Shell](./shell.md)).

- **Splash.** `browser.route("**/assets/index-*.js", (route) => route.abort())`, then `app.open(run.openUrl)`. `img "prkit"` is visible and the title is `prkit`. `tests/branding.e2e.ts` saves `boot-splash`.
- **Favicon.** `link[rel="icon"][type="image/svg+xml"]` has `href="/favicon.svg"`, and `fetch(<url>/favicon.svg)` answers 200 with `image/svg+xml`.
- **Fonts.** Route `/\.(woff2?|ttf|otf)(\?|$)/` and record each URL. After the app loads, `getComputedStyle(document.body).fontFamily` starts with `"Fira Sans"`, `document.fonts` has Fira Sans 400, 400 italic (loaded on demand with `document.fonts.load('italic 400 1em "Fira Sans"')`), 500 and 600 and JetBrains Mono 400 loaded, and every font URL starts with `<url>/assets/`.
- **About prkit.** Press `Meta+Comma`, then tap `link "About"` in `navigation "Settings sections"`. `region "About prkit"` contains `img "prkit"`, `Stay in the loop when agents write the code.`, `Version <apps/server version>` and `Build <build id>`. The test saves `settings-about`.
- **Empty mark.** Not in `pnpm e2e run`: the runner's server sees this machine's gh accounts, which have pull requests. Start an instance whose `HOME` has no gh config (`HOME=/tmp/empty-home "$(mise which node)" scripts/verify-app.ts start --name empty --detach`) and screenshot `/`. The heading reads `Connect your GitHub accounts` under the mark.
- **Title bar mark.** `tests/shell.e2e.ts` (`the title bar carries the prkit mark`) checks where the mark (`[data-workspace-tabbar] svg[aria-label="prkit"]`) and the wash (`[data-titlebar-backdrop]`) sit, their colors in light and dark, and that nothing animates. The traffic lights are native, so the mark beside them needs a window capture of `pnpm dev:desktop`, by hand.
- **Lockup gap, by hand.** In each horizontal lockup (`assets/brand/logo/prkit-logo-{ink,paper,mono-black,mono-white}.svg`) the mark's right edge is the mark group's translate x plus 36 times its scale (the arc's right side plus half its stroke), and the wordmark's first stem is the wordmark path's translate x plus 80. They are 607.2 and 1057.0, a gap of 450 units; the gap was 150 before the owner asked for more room.
- **Desktop.** `pnpm smoke:desktop` covers the window. The Dock and the About panel are native; capture them with a screenshot tool (`screencapture -l <window id>` works) and log `defaults read -g AppleInterfaceStyle` with each capture.

## Gotchas

- In dev the macOS About panel shows Electron's icon: Electron passes the panel no icon, so AppKit uses the bundle's. A bundle that carries `build/icon.icns` shows the prkit icon.
- The splash keys on `html.dark`, which an inline script in index.html sets before the first paint, from the stored theme (`/appearance.js`) or else the OS. Emulate the color scheme on the browser context, or set the theme in Settings; toggling the class after load proves nothing about the splash.
- Font requests repeat on every navigation in a fresh context, and JetBrains Mono 600 loads only when something renders in it.
