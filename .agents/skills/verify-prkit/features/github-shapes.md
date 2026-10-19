# GitHub's shapes

A normal user's inbox holds things the fixtures don't: deleted authors, bots, mannequins and enterprise accounts, deleted forks, team review requests, labels without a color, archived repositories, and pull requests GitHub refuses (an organization's SAML enforcement) or sends in a shape prkit can't read. Every field prkit reads from GitHub follows GitHub's own schema for what may be null and which types a union holds, so each of these shows as GitHub sent it. A pull request prkit still can't read fails alone: the list leaves it out, says so above the rows with a link to it on GitHub when the answer names it, and the server log says where it broke, never what it held.

## Sub-features

- `odd-rows` are the Inbox's and a repository's rows for each shape. A null author reads `deleted user`; GitHub's own deleted account is a user named `ghost` and reads `ghost`. A bot, a mannequin and an enterprise account read by their login.
- `left-out` is `alert` `[data-inbox-left-out="<account>"]`: `Some pull requests couldn't be shown for <account>.` (or `1 pull request` / `<n> pull requests` when GitHub's answer names each one), `prkit couldn't read what GitHub sent.` for one prkit can't read, `GitHub said: <message>` for one GitHub refused, and `link "Open <owner>/<repo>#<n> on GitHub"` for each one named. With no filter on, no empty state claims nothing needs you while it shows. Outside agents and the CLI get the same list as `githubLeftOut`.
- `partial-answer` is a GraphQL answer GitHub sent with errors: a hole GitHub's errors explain fails in GitHub's words, never as "GitHub returned an unreadable response".
- `odd-page` is the PR view of each shape: the header, Conversation and labels render with no `Couldn't load` and nothing invented.

## How to get to it (user POV)

- Open the Inbox on an account whose searches find such pull requests, or filter by a repository where nothing needs you and show its open pull requests, then open one.

## Driving it with e2e

Preconditions:

- `pnpm build` ran after the last change. `tests/github-shapes.e2e.ts` starts its own instances on the fake GitHub, so it needs no fixture repository or lock.

- **Seed.** `fake.odd(n, shape)` adds PR n (10 or more) to the involved search with one shape: #10 a deleted author, #11 a bot, #12 a mannequin with a `budget/web` team request, #13 an enterprise account, #14 a deleted fork that GitHub is still checking, #15 a colorless label, #16 a null label connection, #17 an archived repository, #18 a node that breaks GitHub's schema (a null title) and #19 one GitHub refuses with a FORBIDDEN error.
- **Inbox.** Involved lists #10 to #17, the other groups #1 to #6, and the notice names #18 with its link and quotes GitHub's SAML message for #19. On main the Inbox shows only `GitHub returned an unreadable response. Try refreshing.` and the log says `path: 'involved.nodes.6.labels'`.
- **Repository.** With the inbox empty (`fake.inboxOnly`), the `fixtures` filter's Show open pull requests lists #1 to #6 and #10 to #17 with the same notice.
- **Page.** #10, #11, #12, #14, #15 and #17 open with no load error; #12 names the `budget/web` team, #15 shows its colorless label.
- **Proof.** `pnpm e2e run tests/github-shapes.e2e.ts --output .e2e/proof/<name>` saves `inbox-light`, `inbox-dark`, `inbox-narrow` (720 px, no sideways scroll), `repository-light`, `page-deleted-author`, `page-team-request`, `page-deleted-fork` and `page-archived-dark`.

## Gotchas

- The Inbox footer shows the instance's home path; crop the bottom 48 px of a 720 px frame before filing it.
- The fake's REST pull lists requested reviewers and teams only for `odd` pull requests, so the older journeys' headers stay as they were.
