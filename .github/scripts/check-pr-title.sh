#!/usr/bin/env bash
# Fails unless the pull request title is a conventional commit. The squash merge uses the title
# as the commit subject, and the release version and notes are read from those subjects.
#
#   .github/scripts/check-pr-title.sh "feat(inbox): group PRs by why they need you"
set -euo pipefail

title="${1-}"
types="build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test"
pattern="^(${types})(\([a-z0-9][a-z0-9._/-]*\))?!?: [^ ].*$"

if [[ "$title" =~ $pattern ]]; then
  echo "Conventional title: $title"
  exit 0
fi

{
  echo "::error title=PR title::The title must be a conventional commit: <type>(<scope>)!: <summary>."
  echo "Types: ${types//|/, }. Scope and ! (a breaking change) are optional."
  echo "feat bumps the minor version, fix and perf bump the patch, the others release nothing."
  echo "Example: feat(inbox): group PRs by why they need you"
} >&2
exit 1
