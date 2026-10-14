# Server responsiveness

The inbox and PR views must keep answering while GitHub reads overlap. The GitHub transport uses HTTP/1.1. HTTP reads include queues in a 30-second deadline, Git fetches have a two-minute deadline, response bodies have a byte limit, and read caches have entry and byte limits. Pagination fails safely when comments, reviews, statuses, checks, or timeline reads cannot finish within 30 pages. Files still reports GitHub’s 3,000-file limit. Review threads retain their ten-page truncation limit and use a bounded cache with a 40-second aggregate deadline.

## Sub-features

- `concurrent-reads`: inbox reads for both accounts and PR reads share a bounded, account-bound transport.
- `safe-limits`: deadlines, response size, pagination, and cache limits fail with logged, readable errors.
- `soak`: health latency and server RSS remain bounded while the real UI refreshes repeatedly.

## How to get to it (user POV)

- Open the Inbox through the isolated instance’s printed URL and click Refresh.
- Open a PR, then use Conversation, Files, and unchanged-line expansion.
- Open the fixture’s Guide tab and generate a guide to give the watcher a review to check.

## Driving it with e2e

Preconditions: build after the last change, start an isolated instance, and run its doctor. Both real GitHub accounts must be ready. A nonempty watcher requires one fixture guide in Watching, using the default 60-second interval. Extended soaks must use a local fake-GitHub-backed instance. Any explicitly authorized live check must measure GraphQL resource usage before and after and stay within its allocated budget; this unit’s final live allowance was 300 points.

- **Concurrent refresh:** `tests/server-responsiveness.e2e.ts` opens the Inbox, refreshes six times, checks the fixture row, then opens the fixture and `pingdotgg/t3code#16782` through `github.com/<owner>`. It loads Conversation, then Files, then Conversation's activity rail. Each stage checks that the isolated server’s `/health` answers within 200 ms and identifies the same home.
- **Soak against a local fake GitHub:** run `node scripts/soak-app.ts hang 1800 soak-integrated 180 90` against the supervisor instance. Three windows click `getByRole("button", { name: "Refresh", exact: true })` on both inbox accounts. The fourth cycles Conversation (waits for the activity rail, then clicks its Refresh) and Files (expands the first `[data-unmodified-lines]`) for the Inbox's first PR from each account, through that account, and t3code.
- **Limits:** run `node scripts/verify-github-limits.ts <local TLS directory>` with `NODE_EXTRA_CA_CERTS` pointing at that directory’s `cert.pem`. It offers HTTP/2 locally, verifies HTTP/1.1 POSTs, oversized-body rejection, stalled and queued request deadlines even inside an uninterruptible caller, recovery, cache eviction, action invalidation, endless REST or timeline pagination, action-choice pagination/cursor limits, and review-thread truncation/deadlines. Use a self-signed localhost certificate; this process never calls GitHub.

RSS and CPU samples land every 10 seconds in `.e2e/evidence/hang/soak-integrated/rss.csv`. Health probes land every second in `health.csv`. Actions and API error messages land in `actions.jsonl`. `summary.json` counts successful reads, errors, health failures, and probes over 200 ms. The process exits with a failure when health, navigation, or loaded rows fail. Check alerts separately so a rate-limited run is not mistaken for a successful-read soak. At the first rate-limit alert, the load aborts and stops its recorded instance, preserving the home and evidence.

## Gotchas

- Generate one fixture guide through the Guide tab and let it reach Watching before an explicitly authorized soak. Keep the review and fixture unchanged on GitHub.
- The optional load script uses a 180-second inbox cadence per window while PR views pause 90 seconds between cycles. Faster sustained inbox load can consume GitHub search or API limits; retain those failures rather than counting them as successful reads.
- When a task forbids GitHub writes, leave out the default journeys that open or change fixture PRs: `--grep-invert "PR actions|review comments: drafts|stack|fix"`. The agent journeys write too, and skip by default.
- A live soak reads the real accounts for 30 minutes or more. Run one only when asked, and pace it to stay under GitHub’s secondary rate limit. Count and report alerts separately from successful reads.
- Local certificates belong under `.e2e/`; never change global TLS settings.
- Stop only the supervisor’s recorded instance. Never point a run at `~/.prkit`.
- For a hung process, capture a CPU sample before cleanup. A native loop can prevent both inspector commands and JavaScript timeouts from executing.
