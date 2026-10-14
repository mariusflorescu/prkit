#!/usr/bin/env bash
# Decides what a release run builds: the commit, the version and the release notes.
# Run from the root of a full clone with tags. Reads:
#   CHANNEL       nightly or stable
#   DRY_RUN       true or false
#   COMMIT        the commit the run started on (main HEAD for a release)
#   REF           the ref the run started on; publishing needs refs/heads/main
#   RUN_DATE      the UTC date of the run as YYYYMMDD
#   RUN_NUMBER    the workflow run number
#   REPOSITORY    owner/name, for the PR links in the notes
#   NOTES_FILE    where the release notes go
# Writes release, channel, version, tag, name, commit, prerelease, make_latest and dry_run to
# $GITHUB_OUTPUT and a summary to $GITHUB_STEP_SUMMARY.
#
# A nightly with nothing new is skipped (release=false, exit 0). A release that must not happen
# (stable without a nightly, a stable version that exists, publishing from another branch)
# exits 1.
set -euo pipefail

: "${CHANNEL:?}" "${DRY_RUN:?}" "${COMMIT:?}" "${REF:?}" "${RUN_DATE:?}" "${RUN_NUMBER:?}"
: "${REPOSITORY:?}" "${NOTES_FILE:?}" "${GITHUB_OUTPUT:?}" "${GITHUB_STEP_SUMMARY:?}"

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

summary() { printf '%s\n' "$@" >> "$GITHUB_STEP_SUMMARY"; }
output() { printf '%s=%s\n' "$1" "$2" >> "$GITHUB_OUTPUT"; }
refuse() {
  summary "## Release refused" "" "$1"
  echo "::error::$1" >&2
  exit 1
}
skip() {
  summary "## No ${CHANNEL} release" "" "$1"
  output release false
  echo "$1"
  exit 0
}
release_version() { node "$root/scripts/release-version.ts" "$@"; }

# Newest nightly tag by date and run number, among the tags merged into $1 (default: all tags).
latest_nightly() {
  git tag --list ${1:+--merged "$1"} 'v*-nightly.*' \
    | sed -nE 's/^(v[0-9]+\.[0-9]+\.[0-9]+-nightly\.([0-9]{8})\.([0-9]+))$/\2 \3 \1/p' \
    | sort -k1,1n -k2,2n | tail -n 1 | cut -d ' ' -f 3
}
# Newest stable tag vX.Y.Z merged into $1.
latest_stable() {
  git tag --list --merged "$1" 'v*' | { grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' || true; } \
    | sort -V | tail -n 1
}

case "$CHANNEL" in nightly | stable) ;; *) refuse "Unknown channel \"$CHANNEL\"." ;; esac
if [[ "$DRY_RUN" != "true" && "$REF" != "refs/heads/main" ]]; then
  refuse "Releases publish from main only, and this run started on $REF. Run it as a dry run."
fi

if [[ "$CHANNEL" == "nightly" ]]; then
  commit="$COMMIT"
  previous="$(latest_nightly "$commit")"
  if [[ -n "$previous" && "$(git rev-list --count "$previous..$commit")" == "0" ]]; then
    skip "No commit since the latest nightly, ${previous}."
  fi
  version="$(release_version nightly --date "$RUN_DATE" --run "$RUN_NUMBER")"
  stable="$(latest_stable "$commit")"
  if [[ -z "$version" ]]; then
    skip "Nothing to release: no feat, fix, perf or breaking commit since ${stable:-the first commit}."
  fi
  from="${previous:-$stable}"
  name="prkit Nightly $version"
  prerelease=true
  make_latest=false
else
  nightly="$(latest_nightly)"
  [[ -n "$nightly" ]] || refuse "There is no nightly to promote. Stable releases ship the latest nightly's commit."
  commit="$(git rev-list -n 1 "$nightly")"
  if ! git merge-base --is-ancestor "$commit" "$COMMIT"; then
    refuse "The latest nightly, ${nightly}, is not on main."
  fi
  version="$(sed -nE 's/^v([0-9]+\.[0-9]+\.[0-9]+)-nightly\..*$/\1/p' <<< "$nightly")"
  if git rev-parse --quiet --verify "refs/tags/v$version" > /dev/null; then
    refuse "v$version is already released. The latest nightly, ${nightly}, has nothing newer to promote."
  fi
  from="$(latest_stable "$commit")"
  name="prkit v$version"
  prerelease=false
  make_latest=true
fi

release_version notes --version "$version" ${from:+--from "$from"} --to "$commit" \
  --repository "$REPOSITORY" > "$NOTES_FILE"

output release true
output channel "$CHANNEL"
output version "$version"
output tag "v$version"
output name "$name"
output commit "$commit"
output prerelease "$prerelease"
output make_latest "$make_latest"
output dry_run "$DRY_RUN"

summary "## ${name}" "" \
  "| | |" "| --- | --- |" \
  "| Channel | ${CHANNEL} |" \
  "| Version | ${version} |" \
  "| Commit | \`${commit}\` |" \
  "| Notes from | ${from:-the first commit} |" \
  "| Dry run | ${DRY_RUN} |" \
  "" "### Release notes" ""
cat "$NOTES_FILE" >> "$GITHUB_STEP_SUMMARY"

echo "${name} from ${commit}, notes from ${from:-the first commit}, dry run ${DRY_RUN}:"
cat "$NOTES_FILE"
