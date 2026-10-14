# Guide settings

Ignore rules, focus areas and guidance shape every guide, set in three scopes: Global and Repository in Settings > Guides ("What guides cover"), and each pull request in the Guide tab's setup. The most specific scope wins: a scope switches inherited items Inherit / On / Off, the last matching ignore rule decides a file (a rename is skipped only when both paths are), and a scope's guidance can replace the guidance above it. An attempt freezes the resolved settings when it starts; the Guide status bar shows them and says when they changed since the revision on screen.

## Sub-features

- `guide-config-global` edits Global ignore rules (with presets), focus areas (with suggestions) and guidance.
- `guide-config-repository` picks a repository (by GitHub id) and edits its own items, overrides on Global items, and guidance with append or replace.
- `guide-config-setup` shows one muted line in the guide setup's Settings row, "Skipping N files · N focus areas · Guidance: Global + this PR"; each item opens the PR's own settings and the per-file preview with the deciding rule.
- `guide-config-guard` blocks Generate when every changed file is skipped and names every deciding rule; an attempt that finds the same fails with reason `settings`.
- `guide-config-frozen` freezes settings per attempt; the status bar shows "Written with ..." and "Settings changed since this revision · Regenerate"; a changed hash starts a fresh session.
- `guide-config-focus-answers` shows the agent's answers under "Your focus areas" in the overview, and its optional note on conflicting guidance above the guide.
- `guide-config-stale-save` refuses a save from a form loaded before another save of the same section.

## How to get to it (user POV)

- Settings (`Cmd+,`) > Guides > What guides cover: Global, then Repository with its picker.
- A PR's Guide tab setup, and the setup inside "Generate again with other settings".
- The Guide status bar of a written guide: the "Written with ..." button and the staleness notice.

## Driving it with e2e

Preconditions:

- `pnpm build`. The inbox must have loaded in the browser before Settings: the repository picker lists the inbox's repositories without reading GitHub.
- Rename fixture: `<fixture>#103` "Move the store into lib" (`src/store.js` -> `lib/store.js`, rename only). Keep it open.

- **Global.** `form "Global ignore rules"`: `button "Add rule"`, `textbox "Rule 1"`, `button "Save ignore rules"` (hidden again once saved). Presets: `button "Add the Tests preset"`. Focus: `form "Global focus areas"`, `button "Add the Security focus area"`, `button "Save focus areas"`. Guidance: `form "Global guidance"`, `textbox "Global guidance"`, `button "Save guidance"`. Stored in `guide_config` (`scope = 'global'`, one row per section with a `version`).
- **Repository.** `pickGuideRepository(screen, FIXTURE_REPO)` from `tests/pickers.ts`, then `form "Repository ignore rules"`; inherited items behind `button "1 inherited, all on"`, each `listitem "<pattern>, from Global"` with `radiogroup "<pattern>: inherit, on or off"` and `radio "Off"`. Stored under `scope = 'repository:github.com/<databaseId>'`.
- **Setup.** `group "Guide settings"` holds the line's three buttons. The ignore item opens `group "Ignore rules for this pull request"` with `list "Files and the rules that decide them"`, rows `listitem "<path>: reviewed|skipped"`, `button "Why <path>"` and `list "Rules matching <path>"` ("test/ (Global) · overridden by a later rule", "… · decides: keeps"), then `form "This pull request ignore rules"`. Focus: `form "This pull request focus areas"`. Guidance: `button "Add a focus"` opens `textbox "Guidance for this pull request"` (open already when the PR has saved guidance), and the guidance item holds `radiogroup "How this pull request's guidance combines with the guidance above"`. The PR's guidance is saved by Generate (`scope = 'pull-request:<key>'`).
- **Guard.** A PR rule `*` gives `alert "Generation blocked"` and a disabled `button "Generate guide"`.
- **Frozen settings and fresh sessions (agent).** `PRKIT_E2E_AGENT=1 pnpm e2e run tests/guide-config.e2e.ts --tag agent` runs Claude twice: the Global guidance is edited while r1 is written, r1 still records the old text (`review_attempts.config`), the status bar shows `[data-revision-settings]` and `status "Settings changed since this revision"`, `region "Your focus areas"` has one item, and the guide ends with "Skipped by your ignore rules". Replace mode then writes r2 in a new session; the server log has "Composed the prompt" sections without `guidance:global` and "Guide settings changed since the last revision; starting a fresh session".
- **Stale save.** e2e drives one tab, so this runs as a Playwright script with two pages in one context against `pnpm verify:app start --name <name> --detach`: both load Global ignore rules, the first saves, the second gets `alert` "These settings changed since you opened them …" with `button "Reload"`.
- **Proof.** `tests/guide-config.e2e.ts` saves `settings-repository-negation`, `composer-preview-negation`, `composer-preview-switched-back-on`, `composer-everything-skipped`, `composer-rename-either-side`, `composer-rename-both-sides`, `settings-focus-and-guidance`, `composer-guidance-replace`, and with `--tag agent` `agent-r1-frozen-settings` and `agent-r2-replaced-guidance`.

## Gotchas

- The default journeys run serially on one instance and build on each other's settings; the third leaves #1 with every file skipped.
- The setup's preview reads GitHub's files list; the attempt decides again on the diff it fetches, which is what counts.
- Editor forms inside the setup's popovers stop their submit event: React bubbles it through the portal into the setup's form, which would start a guide.
- A clean form follows the server; an edited one keeps the version it loaded, so a refocus refetch never wipes edits and a stale save is refused.
