# Pickers

Every choice from a list is one compact family: 28px rows at 12px, small group headings, a compact search field, and a check that lines up on every row. Selects (`components/ui/select.tsx`), searchable pickers (`components/ui/search-picker.tsx` over `combobox.tsx`) and menus (`components/ui/menu.tsx`) share those rows. A searchable picker says so in its list when the search finds nothing (`No matches` for labels and reviewers).

## Sub-features

- `picker-account` is the Inbox's `combobox "Filter by GitHub account"`, a compact select, hidden with one account.
- `picker-repository` is the Inbox's repository filter and the Settings > Guides repository picker, one searchable popover with `combobox "Search repositories"`, grouped by owner.
- `picker-model` is the guide setup's `button /^Agent and model: /`, grouped by turned-on agent instance with each login, searched with `combobox "Search models"` (the search also matches an instance's label and id); a model's description is one muted line. When two instances of one agent are on, or an instance has an accent, its group, the button and the button's name carry the instance (`Agent and model: Claude Sonnet 5.5 · Work`, an initials marker with the accent dot).
- `picker-metadata` is the labels and reviewers pickers in the PR header, a searchable list (`combobox "Search labels"`, `combobox "Search reviewers"`) instead of checkboxes and native selects.
- `picker-select` is the merge form's `combobox "Method"`, the effort menu, `combobox "Guide revision"` and the DEV `combobox "Guide fixture"`.

## How to get to it (user POV)

- Inbox: the account filter and `button "Filter by repository: All repositories"`.
- Settings > Guides: `button /^Repository/`.
- A PR's Guide tab: the agent and model button, then the model's effort menu; `combobox "Guide revision"` once a guide exists.
- A PR header: Edit labels, reviewers, and the merge form's Method.

## Driving it with e2e

Preconditions:

- `pnpm build`. The helpers in `tests/pickers.ts` open each picker the user's way: `choose(screen, trigger, option)`, `chooseOtherAccount(screen, browser, login)` and `pickGuideRepository(screen, name)`.

- **Account.** `tests/accounts-inbox.e2e.ts` picks the second account with `chooseOtherAccount`. `tests/inbox-filters.e2e.ts` checks the select is absent on the fake's one account.
- **Repository.** `tests/inbox-filters.e2e.ts` opens the Inbox filter on the fake: `option "fixtures 6 in your inbox"` under the group label `budget`. `tests/guide-config.e2e.ts` uses `pickGuideRepository` in Settings > Guides.
- **Model.** `tests/guide-generation.e2e.ts` taps `button /^Agent and model: /`, sees `combobox "Search models"`, `Claude` and `Codex` in the `listbox`, types `opus` and picks `option /Claude Opus 5\.5/`.
- **Labels.** `tests/pr-actions.e2e.ts` (`agent` tag) fills `combobox "Search labels"` with a nonsense name and reads `No matches` in the dialog's `status`, then picks `option "bug"` (`aria-selected="true"`).
- **Method.** `tests/pr-actions.e2e.ts` picks each merge method with `choose(screen, combobox "Method", METHOD_LABELS[method])`.
- **Fixture.** `tests/guide-viewer.e2e.ts` picks each DEV fixture from `combobox "Guide fixture"`.
- **Two instances.** `tests/agent-instances.e2e.ts` adds a second Claude: searching `sonnet` lists `option /Claude Sonnet 5\.5/` twice, once per instance group, and searching an instance id keeps only its models. A turned-off instance's id finds nothing.
- **Rows.** `tests/compact-pickers.e2e.ts` runs on the fake GitHub with a second account and the stand-in Claude. Once each list has faded in, the account filter (3 rows), the repository filter (3), the guide setup's model list (4) and Settings > Guides' repository picker (1) have rows of at most 30px and no text over 13px, with light and dark screenshots. Once each has loaded (its own heading, region or row shows and nothing is `aria-busy`), no `select` exists on the Inbox, the four PR tabs or the six Settings sections.
- **Look, by hand.** The check column aligned on every row, and small group headings.

## Gotchas

- A picker's options exist only while it is open. Tap the trigger before `getByRole("option", ...)`.
- The repository lists read GitHub the first time they open; on real accounts wait for the option with a timeout instead of asserting at once.
