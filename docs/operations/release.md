# Releasing prkit

prkit ships as a signed and notarized macOS app (Apple Silicon) through GitHub Releases in this repository. The app updates itself from those releases and shows the release bodies as its changelog. Two workflows do the work:

- `.github/workflows/ci.yml` runs on every pull request and on every push to `main`.
- `.github/workflows/release.yml` publishes a nightly every 4 hours when `main` has something new, and a stable release when you ask for one.

Nobody picks a version by hand. git-cliff reads the commit subjects on `main`, and `scripts/release-version.ts` turns them into a version and release notes.

## How a nightly is made

Every 4 hours, at 17 minutes past 00:00, 04:00, 08:00, 12:00, 16:00, and 20:00 UTC, the release workflow takes `main` HEAD and decides whether a nightly is due. It skips, with the reason in the run summary, in two cases:

- `main` has no commit since the latest nightly tag.
- No commit since the last stable tag is a `feat`, `fix`, `perf`, or breaking change. `node scripts/release-version.ts next` prints nothing in that case.

A run that skips ends after its first job, **Resolve version**, about 30 seconds on Linux. The macOS build and the publish job never start.

Otherwise the nightly gets the next stable version plus the date and run number, for example `0.2.0-nightly.20261014.37`. Each new run takes a higher run number, so two nightlies on one day still sort in order: `.37` before `.41`. The workflow builds, signs, notarizes, and verifies the app, then publishes the release **prkit Nightly 0.2.0-nightly.20261014.37**. It is a prerelease and never the latest release. Its notes cover the commits since the previous nightly, or since the last stable release when there is no previous nightly.

The workflow then deletes every nightly release and tag older than the 14 newest, which is at least two days of nightlies at six a day. The app never needs an older one. An update needs only the newest release, whose update manifest carries the changelog (see [Release notes in the app](#release-notes-in-the-app)). The changelog is rebuilt from the nightly tags, so keep at least 10.

To run a nightly now, open **Actions > Release > Run workflow**, keep `main` and the `nightly` channel, and click **Run workflow**. A manual nightly skips for the same reasons as the scheduled one.

A failed nightly needs no retry, because the next scheduled run, at most 4 hours later, publishes everything it would have. To retry sooner, run a new one, which builds, signs, and notarizes the app again. **Publish** refuses every re-run of a nightly. A re-run keeps its run number and commit, so after a later nightly it would publish older code.

## Publish a stable release

A stable release ships the exact commit of the latest nightly, not `main` HEAD. Test the nightly first, then promote it.

1. Install the latest nightly and check it by hand (see [Check a new release by hand](#check-a-new-release-by-hand)).
2. Open **Actions > Release > Run workflow**.
3. Keep the `main` branch, pick the `stable` channel, and click **Run workflow**.

The workflow builds the nightly's commit again as `X.Y.Z`, the version the nightly previewed. For example, `0.2.0-nightly.20261014.37` becomes `v0.2.0`. It publishes **prkit v0.2.0** as the latest release, with notes from the last stable release to that commit.

The workflow refuses, and publishes nothing, when:

- No nightly exists.
- The tag `vX.Y.Z` already exists. The latest nightly was already promoted. Wait for a newer nightly.
- The latest nightly's commit is not on `main`.
- The run did not start on `main`. Only a dry run may start elsewhere.

## How versions are chosen

prkit merges every pull request as one squash commit whose subject is the PR title plus `(#N)`. git-cliff reads these subjects since the last stable tag `vX.Y.Z` and ignores nightly tags. Below 1.0 the rules are:

| Commits since the last stable release | Next version from `0.3.4` |
| --- | --- |
| Only `chore`, `docs`, `test`, `ci`, `build`, `refactor`, `style`, or `revert` | No release |
| At least one `fix` or `perf` | `0.3.5` |
| At least one `feat` | `0.4.0` |
| A breaking change: `feat!:`, `fix!:`, `refactor!:`, or a `BREAKING CHANGE:` footer | `0.4.0` |

The first release is `0.1.0`. Commits that are not conventional, such as `Initial commit`, count for nothing.

The release notes list Features (`feat`), Fixes (`fix`), and Performance (`perf`). Each line is the subject without its type and scope, and `(#N)` becomes a link to the pull request. The notes never name an author and never include a commit body. Every other type stays out of the notes, even when it is a breaking change. If nothing user-facing changed, the body says so.

To see what the next release would be, run these in a full clone with tags:

```sh
node scripts/release-version.ts next
node scripts/release-version.ts nightly --date 20261014 --run 1
node scripts/release-version.ts notes --version 0.2.0 --from v0.1.0
node scripts/release-version.ts manifest-notes --version 0.2.0 --from v0.1.0
```

`next` and `nightly` print nothing and exit 0 when there is nothing to release. Every subcommand exits 1, with the reason on stderr, on bad input.

## Release notes in the app

The app reads its changelog from the update manifest (`latest-mac.yml` or `nightly-mac.yml`), not from GitHub's releases feed. That feed lists only the 10 newest releases, so under two days of nightlies would push a stable release out of it, and a Stable user would get the update with no notes.

The **Resolve version** job runs `release-version.ts manifest-notes`, which prints the manifest's `releaseNotes` as JSON, newest first: the new release's notes, then the releases before it on the same track, 10 in all at most. Each earlier release gets the notes it was published with, rebuilt by git-cliff from the tag before it on the track to its own tag. The first stable release starts at the first commit. The oldest nightly tag left is skipped, because the tag where its notes start may be deleted. The **Build** job passes the JSON to `pnpm dist:desktop:artifact --release-notes`, which writes it into the manifest. The release body on GitHub is the first entry's notes.

The app keeps the versions the update brings: newer than the version it runs, up to the offered one, on its track. It shows the newest 6 and says when it left older ones out.

## Write the PR title as a conventional commit

The PR title becomes the commit subject, so the title decides the version and the line in the release notes. The **PR title** job in CI fails unless the title looks like this:

```
<type>(<scope>)!: <summary>
```

- `type` is one of `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`, `chore`, `style`, or `revert`.
- `(<scope>)` is optional, in lower case: `feat(inbox): ...`.
- `!` is optional and marks a breaking change.
- Write the summary for the person who reads the changelog. "Group PRs by why they need you" helps them. "Refactor InboxStore" does not.

CI checks the title again when you rename the PR.

## What CI runs

- **Check** (macOS, because some server tests fail on Linux): `pnpm install`, `pnpm typecheck`, `pnpm lint`, `pnpm fmt:check`, the unit tests (`pnpm exec vp test --run`), and `pnpm build`.
- **PR title**: the conventional commit check above.
- **Package** (macOS): an unsigned app built with `pnpm dist:desktop:artifact --build-version 0.0.0-ci.<run>`, kept for 3 days as a workflow artifact. It runs on every push to `main`. On a pull request it runs only when the PR changes `apps/desktop/`, `scripts/build-desktop-artifact*`, or `apps/server/vite.config.ts`.
- **CI**: passes when every job above passed or was skipped for its reason. Branch protection needs only this check.

## Secrets and variables

The secrets live in the `release` environment, which admits only the `main` branch. The variables are repository variables. Do not rename or delete the environment: the release workflow asks for it by name.

| Name | Kind | Holds |
| --- | --- | --- |
| `CSC_LINK` | Secret | The Developer ID Application certificate and its private key, as a base64 `.p12`. |
| `CSC_KEY_PASSWORD` | Secret | The password of that `.p12`. |
| `APPLE_API_KEY` | Secret | The text of the App Store Connect API key (`AuthKey_<id>.p8`), used to notarize. The workflow writes it to a file in the runner's temporary directory for the build. |
| `APPLE_API_KEY_ID` | Secret | The key ID of that API key. |
| `APPLE_API_ISSUER` | Secret | The issuer ID of the App Store Connect team that owns the key. |
| `APPLE_TEAM_ID` | Variable | The Apple Developer team ID. |
| `PRKIT_DESKTOP_APP_ID` | Variable | The bundle ID. Updates find the installed app by this ID, so never change it after the first release. |

Publishing uses the workflow's own `GITHUB_TOKEN`. prkit needs no personal access token and no GitHub App.

If any of these is missing, the workflow still builds, but unsigned, and it publishes nothing. The run stays green, and the build summary lists the missing names. Download the unsigned app from the run's artifacts.

## Rotate the certificate or the API key

Rotate before the Developer ID certificate expires, or at once if a key leaks.

1. To replace the certificate, create a new Developer ID Application certificate in the Apple Developer account. Export it with its private key from Keychain Access as a `.p12` with a new password.
2. Run `base64 -i certificate.p12 | gh secret set CSC_LINK --env release`, then `gh secret set CSC_KEY_PASSWORD --env release` and type the password.
3. To replace the API key, create a new key in App Store Connect under **Users and Access > Integrations**, with the Developer role. Download `AuthKey_<id>.p8`.
4. Run `gh secret set APPLE_API_KEY --env release < AuthKey_<id>.p8` and `gh secret set APPLE_API_KEY_ID --env release`, and type the key ID. Update `APPLE_API_ISSUER` the same way if the team changed.
5. Run a nightly by hand and check that the build summary says **Signing and notarizing** and that the run publishes the nightly.
6. Revoke the old key in App Store Connect. Revoke the old certificate only after the new nightly installs and updates. Apps already signed with the old certificate keep opening after you revoke it, unless Apple revokes it for a compromise.
7. Delete the local `.p12` and `.p8` files.

## Do a dry run

A dry run builds the release without publishing it. Use it to check a workflow change or a packaging change before it ships.

1. Open **Actions > Release > Run workflow**.
2. Pick the branch and the channel, tick `dry_run`, and click **Run workflow**.

A dry run never asks for the `release` environment and never reads its secrets, so it may start on any branch. It resolves the version and notes exactly like a real run, builds the app unsigned, and uploads it as a workflow artifact. The summary says **Dry run: built unsigned without the release environment. Not published.** It creates no tag and no release.

## Check a new release by hand

Do this on a Mac before you promote a nightly, and again after the first stable release:

1. Download the `.dmg` from the release page and open it. Drag prkit to Applications.
2. Open prkit from Applications. Gatekeeper must open it without a warning. A prompt that says Apple cannot check the app for malicious software means notarization failed: do not promote the release.
3. In Terminal, run `spctl -a -vv /Applications/prkit.app`. The output must say `accepted` and `source=Notarized Developer ID`.
4. Check that the inbox loads and that a PR opens.
5. Install the previous release of the same channel on a Mac, then open it. It must offer the new release as an update. Install the update, and check that the app restarts as the new version and shows the new release notes as its changelog.
