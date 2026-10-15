# The website

The marketing site is the Astro project in `apps/www`. It builds to static files in `apps/www/dist` and is hosted on Vercel through the Git integration: every push to `main` deploys production, and every pull request gets a preview. Nothing in it runs on a server.

The download buttons turn on by themselves when a stable release exists on GitHub, with no redeploy. See [How the download switches on](#how-the-download-switches-on).

## Vercel project settings

Import the repository once in the Vercel dashboard (**Add New > Project**), then set:

| Setting | Value |
| --- | --- |
| Production branch | `main` |
| Root Directory | `apps/www` |
| Framework Preset | Astro (also set by `apps/www/vercel.json`) |
| Install, build, output | from `apps/www/vercel.json`; leave the dashboard overrides off |
| Node.js version | 24.x, the default. The root `engines.node` (`^24.13.1`) asks for 24.x too |
| Include files outside the Root Directory | on, the default for a monorepo. The build reads the lockfile, the root `node_modules` and `assets/brand` |

Environment variables (**Settings > Environment Variables**):

| Name | Environments | Value |
| --- | --- | --- |
| `ENABLE_EXPERIMENTAL_COREPACK` | all | `1`. Vercel then runs the pnpm in the root `packageManager` field (pnpm 11). Without it Vercel picks pnpm 9 or 10 from the lockfile, which can't install this workspace |
| `GITHUB_URL` | all | The public repository's URL, `https://github.com/<owner>/<repo>`. Every GitHub link points here, and the release lookup reads owner and repo from it. Without a path there are no release lookups and the page stays on "Coming soon" |
| `SITE_URL` | Production | The site's public origin, `https://<domain>`. It sets the canonical URL and absolute `og:image` URLs. Leave it out for Preview, so previews never claim to be the real site |

None of these is a secret.

### What `apps/www/vercel.json` does

- **Install:** `pnpm install --frozen-lockfile --prod --ignore-scripts --filter @prkit/www...`
  - `--filter @prkit/www...` installs only the site and the workspace packages it depends on (none today): no Electron, no server, no desktop toolchain.
  - pnpm always installs the workspace root's dependencies too, and ours are all dev tooling (Vite+, TypeScript 7, the e2e runner). `--prod` leaves them out, and with them the site's own devDependencies (`astro check`, Playwright), which the build doesn't use.
  - `--ignore-scripts` skips the root `prepare` script, which patches a TypeScript that `--prod` didn't install. `sharp` needs no script: it ships prebuilt binaries for each platform.
  - The result is about 220 MB of `node_modules`, against 740 MB with the root's tooling.
- **Build:** `pnpm run build` (`astro build`), output `dist`.
- **Ignored Build Step:** `[ -n "$VERCEL_GIT_PREVIOUS_SHA" ] && git diff --quiet "$VERCEL_GIT_PREVIOUS_SHA" HEAD -- . ../../assets/brand ../../package.json ../../pnpm-lock.yaml ../../pnpm-workspace.yaml`
  - It runs in the Root Directory and compares the commit with this project's last successful deployment on the branch. Without a previous SHA, it builds because there is no successful deployment to compare against, even if the latest commit only changes docs.
  - Exit 0 (nothing the site reads changed) skips the deployment, and exit 1 builds. A git error also exits non-zero, so when in doubt it builds.
  - The paths are the site, the brand kit it imports, and the files that decide what gets installed.
  - Vercel's own "skip unaffected projects" for monorepos may skip a commit first. It agrees with this list, because a change outside the pnpm workspace (like `assets/brand`) counts for every project.

If a build is skipped by mistake, open **Deployments > ... > Redeploy** and uncheck **Use project's Ignore Build Step** to build it anyway.

## Preview deployments

Every push to a pull request's branch deploys a preview. Vercel comments the preview URL on the pull request. Previews are not indexed by search engines.

For a pull request from a fork, Vercel waits until a member of the Vercel team authorizes the deployment, so a stranger's code never runs with the project's environment variables. That is Git Fork Protection (**Settings > Security**), on by default. Keep it on, and read the diff before you authorize a fork's preview.

## Attach the domain

The domain's DNS is already on Vercel, so Vercel writes the records itself.

1. Open the project, then **Settings > Domains > Add Domain**.
2. Enter either:
   - a subdomain (for example `prkit.<domain>`): Vercel adds the CNAME in its own DNS;
   - the apex (`<domain>`): Vercel adds the A record and offers to add `www.<domain>` too. Accept it and redirect one to the other.
3. Wait until the domain shows as valid. Vercel issues the certificate.
4. Set `SITE_URL` (Production) to `https://` plus that domain, then redeploy production (**Deployments > ... > Redeploy**). Environment variables only reach new builds.

## How the download switches on

The built page always says "Coming soon". It is right with JavaScript off and before GitHub answers. In the browser, `apps/www/src/download.ts` asks `https://api.github.com/repos/<owner>/<repo>/releases/latest` once per visit, with a 5 second timeout. `apps/www/src/release.ts` accepts the answer only when:

- the release is published and not a prerelease (nightlies are prereleases, and `releases/latest` never returns them anyway);
- the tag is `vX.Y.Z`;
- it has the asset `prkit-X.Y.Z-arm64.dmg`.

Then the hero button links to that disk image, the header pill drops "Soon", and the closing band offers the download, the release notes and all releases. Anything else (404 before the first stable release, 403 when the visitor's 60 unauthenticated GitHub calls an hour are spent, a network error, a slow answer, an unexpected body) leaves the page on "Coming soon" without a word.

A found release and a 404 are kept in `sessionStorage` for 10 minutes, so moving around the page doesn't ask again.

### After the first stable release

Once the release workflow publishes `vX.Y.Z` (see [release.md](release.md)):

1. `curl -s -o /dev/null -w '%{http_code}\n' https://api.github.com/repos/<owner>/<repo>/releases/latest` prints `200`, and the release has the `prkit-X.Y.Z-arm64.dmg` asset.
2. Open the site in a private window. The hero reads "X.Y.Z is out for macOS", and the button says "Download for macOS" with `vX.Y.Z · Apple Silicon`.
3. The button and the band's "Download for macOS" both download the disk image. "Release notes" opens the release page.

Nothing needs a redeploy. A tab that already looked within the last 10 minutes keeps "Coming soon" until that time is up.

## Test both states locally

- `pnpm build:www`, then `pnpm e2e run tests/www.e2e.ts`. The download journeys serve the built page as built for a placeholder repository and answer GitHub's API themselves: a 404, a stable release, a 403, a network failure, a slow answer, and JavaScript off. The stable-release journey also checks that nothing on the page moves when the buttons switch on.
- `pnpm exec vp test run apps/www/src/release.test.ts` checks which GitHub answers count as a stable download.
- To look at the page by hand, build with a repository (`GITHUB_URL=https://github.com/<owner>/<repo> pnpm build:www`) and run `pnpm preview:www`. Until the first stable release the real API answers 404 and you see "Coming soon". The switched-on page is easiest to see in the stable-release journey's video, under `.e2e/results/` after an e2e run.
