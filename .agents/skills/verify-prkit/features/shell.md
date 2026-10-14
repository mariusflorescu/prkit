# Shell

The window is drawn like the app icon. The 52px title bar sits on a frame in the icon's outer color and starts with the prkit mark over a still rose wash in its top-left corner (behind the macOS traffic lights in Electron), then the fixed Inbox tab, a short vertical line once at least one PR tab is open, compact PR tabs, and the plus button. Everything below the bar is a panel inset 6px from the frame on the left, right and bottom, with 10px corners, a hairline ring and a 1px top highlight. The active tab is cut from the same material. The plain web build looks the same without the traffic lights. There is no sidebar. Settings opens as a closeable tab at the end of the strip, after the PR tabs (see [Settings](./settings.md)).

## Sub-features

- `shell-titlebar` is the one horizontal bar: mark and wash (see [Branding](./branding.md)), Inbox tab, separator, PR tabs, the Settings tab when open, plus button. No `[data-app-sidebar]`.
- `shell-inset-frame` is the frame and the workspace panel (`[data-workspace-panel]`), the active tab in the panel's material, inactive tabs plain on the frame with a hover fill, and toasts, tooltips and the palette clear of the panel's edge.
- `shell-inbox-tab` is the fixed tab. Cmd+1 selects it; Cmd+W never closes it or the window.
- `shell-settings` opens the Settings tab from Cmd+,, the app menu or Cmd+K, and closes it back to the previous tab from its × or Cmd+W.
- `shell-palette` opens PR search from Cmd+N, Cmd+T or the plus button, without the Settings command; Cmd+K also offers Settings.
- `shell-hints` show shortcuts on hover: the plus button's tooltip has ⌘N and ⌘T, the Inbox tab's ⌘1.
- `shell-app-info` is the footer with the server version and home.
- `shell-token` explains a missing session token with Retry.
- `shell-doctor` is `pnpm verify:app doctor` refusing a server from another build.

## How to get to it (user POV)

- Open the isolated run's `openUrl`.
- Choose `link "Inbox"` in `navigation "Workspace tabs"`, or press Cmd+1.
- Press Cmd+, to open Settings. The macOS app menu also has Settings….
- Press Cmd+K, search Settings, and choose `button "Settings"`.
- Press Cmd+N or Cmd+T, or choose `button "Open a pull request"`, to search for a PR.

## Driving it with e2e

Preconditions:

- `pnpm build`. Run `pnpm e2e run tests/shell.e2e.ts tests/auth.e2e.ts tests/verification.e2e.ts --trace=on --video=on`.

- **No sidebar.** `tests/shell.e2e.ts` closes every PR tab: `[data-app-sidebar]` is absent, `status` says `No open pull requests`, and the strip has no `separator`. Once a PR is open (`tests/accounts-inbox.e2e.ts`, `tests/inbox-filters.e2e.ts`), one `separator` sits between Inbox and the PR tabs.
- **Inbox stays.** Press Cmd+W: `link "Inbox"` keeps `aria-current="page"` and the window stays open.
- **Settings.** Press Cmd+,: the path is `/settings/accounts`, `link "Settings"` in the strip has `aria-current="page"`, one `separator` sits between it and the Inbox, and there is no `button "Back"`. The journey saves `settings-tab`. Cmd+W returns to `/` and the tab and the line are gone. Cmd+K, search `settings`, tap `button "Settings"`, then `button "Close Settings"`: the path is `/` again.
- **Palette.** Cmd+T, Cmd+K and Cmd+N each focus `searchbox "Find a pull request"`. After Cmd+N and after `button "Open a pull request"`, the dialog has no `button "Settings"`.
- **Hints.** Hover `button[aria-label="Open a pull request"]`: `[data-slot="tooltip-popup"]` contains `⌘N`. Hover `link "Inbox"`: it contains `Inbox ⌘1`. The journey saves `open-pr-shortcut-tooltip`. By hand: the same tooltip also shows `⌘T`.
- **Title bar.** `tests/shell.e2e.ts` reads it in light and dark, on an instance of its own over the fake GitHub, because Appearance journeys leave the shared instance's theme set: `[data-titlebar-backdrop]` spans `0,0` to `360,52`, and the mark (`[data-workspace-tabbar] svg[aria-label="prkit"]`, hidden from assistive tech) sits inside it at `16,18` to `77,34`. The wash's two gradients start at `rgb(255, 231, 236)` and `rgb(250, 159, 180)` at strengths `0.85` and `0.2` in light, and `rgb(172, 40, 86)` and `rgb(224, 68, 110)` at `0.3` and `0.1` in dark, and nothing in it animates.
- **Inset frame.** `tests/shell.e2e.ts` (`the workspace sits on a panel inset from the window's frame`) opens fake PR #1 on an instance of its own and reads computed styles in light and dark. The body (the frame) is `rgb(242, 238, 233)` or `rgb(21, 17, 13)`. The bar is 52px with no bottom border. `[data-workspace-panel]` sits 6px from the window's left, right and bottom edges and 52px from the top, with a `10px` radius, `overflow: clip`, the panel color `rgb(252, 250, 247)` or `rgb(25, 21, 17)`, and three shadows: a 1px ring (`rgba(25, 21, 17, 0.1)` or `rgba(255, 255, 255, 0.1)`), a 1px inset top highlight (`rgb(255, 255, 255)` or `rgba(255, 255, 255, 0.08)`) and a lift. The active tab (`[data-active-tab=true]`) has the panel color, the ring and the highlight; the other tabs are transparent with no shadow, and hovering one fills it with `rgba(25, 21, 17, 0.05)` or `rgba(252, 250, 247, 0.05)`. The copy-checkout toast sits 22px (6 + 16) from the window's right and bottom edges. The `Open a pull request` tooltip and the palette dialog render outside the panel, and the dialog is on top at its center. The journey saves `inset-frame-{pr,toast,inbox,palette}-{light,dark}`. By hand: scrollbars inside the panel stop 10px short of its corners (`::-webkit-scrollbar-track:vertical` margin); Playwright hides scrollbars unless launched without `--hide-scrollbars`.
- **App info.** `testid="app-info"` contains `prkit <apps/server version>` and the isolated home.
- **Token.** `tests/auth.e2e.ts` opens `/` without a token: `footer[role="alert"]` explains how to get back in and has `button "Retry"`.
- **Doctor.** `tests/verification.e2e.ts` runs `verify-app doctor` (exit 0), then rewrites `apps/server/dist/build.json` and expects exit 1 with `FAIL build`, and restores the file.
- **Desktop.** `pnpm smoke:desktop` starts the built Electron shell with the bare PATH launchd gives a Dock launch and checks that Settings > Accounts reports no missing `gh` (main rebuilds PATH from the login shell), that Cmd+, and the app menu's `Settings…` open the Settings tab and Cmd+W closes it, the Inbox tab, that no app menu accelerator is Cmd+N and that Cmd+N in the window opens the palette, server info, and child shutdown.

## Gotchas

- Ctrl replaces Cmd on Windows and Linux; the journeys pick the modifier from `navigator.platform`.
- Journeys share one instance, so the shell journey closes PR tabs other journeys left open before it asserts the empty strip.
- The mark and wash next to the traffic lights need a window capture, since Playwright screenshots exclude the native buttons.
- The panel's 10px radius is the window's corner minus the 6px inset. macOS 26 rounds a window without a toolbar at 16pt and one with a toolbar at 26pt; prkit's `hiddenInset` window has no toolbar (System Events lists only its content group and three buttons). Recheck if the window ever gains a toolbar or macOS changes its corners.
