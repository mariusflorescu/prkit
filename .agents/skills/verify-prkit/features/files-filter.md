# Files tree filter

Above the Files tab's tree, a search field narrows the tree by path, and one small toggle keeps only the files still to review. The filter narrows the tree, never the diff list, so cards, comments being written and reviewed marks stay put. It works from the keyboard: `/` opens it (and shows a hidden tree), Enter opens the first match, `r` then ticks it. Each open PR keeps its filter for the session.

## Sub-features

- `filter-path` is `searchbox "Filter files"` (placeholder `Filter by path`, a `/` hint while empty, a clear button while not). Every word must appear, in any case, in the path or the path a rename came from. The tree's heading reads `Files 3 of 6` while filtering.
- `filter-to-review` is `button "Only files to review"` (pressed when on), shown once the reviewed marks are read. It keeps unreviewed files and files changed since you reviewed them; a file prkit can't version never counts.
- `filter-empty` shows `No files match` with `button "Clear filter"` (status role) instead of the tree.
- `filter-keys`: `/` outside a text field focuses the field, showing the tree first when it was hidden; Enter opens the first match in the tree and focuses its card; ArrowDown moves to the first row; Escape clears the text, and on an empty field goes back to the list.
- `filter-memory` keeps the text and the toggle while the reader switches inner tabs; a relaunch starts without them.

## How to get to it (user POV)

- Open a PR, choose `Files`, and type in the field above the tree, or press `/`.

## Driving it with e2e

Preconditions:

- `pnpm build` ran after the last change. `tests/files-filter.e2e.ts` starts its own instance on the fake GitHub and serves six files in four folders with `fake.files(1, ...)`, so it needs no fixture repository.

- **Path.** Type `inbox`: three rows, `Files 3 of 6`, and still six cards. `guide view` leaves `src/guide/GuideView.tsx` alone.
- **Empty.** Type something no path holds: `No files match`, no tree. `Clear filter` empties the field, focuses it and brings every row back.
- **Keys.** With nothing focused, `/` focuses the field; type `reviews`, Enter: `server/reviews/Reviews.ts`'s card takes focus at the top, and `r` ticks it. Escape clears the text; Escape again leaves the field.
- **To review.** `Only files to review` drops the ticked file; ticking `docs/inbox.md` drops it too; with `inbox` typed, two rows and `Files 2 of 6`.
- **Memory.** Conversation and back to Files: the text and the toggle are kept.
- **Hidden tree.** `Hide file tree`, then `/`: the tree is back and the field has focus.
- **Proof.** `pnpm e2e run tests/files-filter.e2e.ts --output .e2e/proof/<name>` saves `filter-no-match` and `filter-to-review` in light and dark, `filter-one-match` and `filter-900`.

## Gotchas

- The field is `type="search"`, so its role is `searchbox`, not `textbox`.
- There are two `Clear filter` buttons when nothing matches (the field's own and the empty state's); scope to `[data-file-tree-panel] [role="status"]`.
