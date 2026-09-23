#!/bin/sh
# Run by the root package.json "prepare" script on every `pnpm install`.
# Points git at this repo's tracked hooks (.githooks/) -- see
# .githooks/pre-push and the "Pre-push code review hook" section in
# README.md for what they do, including that the pre-push hook sends the
# diff of every push to the Claude Code CLI for review when it's on PATH.
#
# Two things this deliberately does NOT do:
#  - It never fails `pnpm install`: outside a git work tree (a Docker build
#    context that copied the source without .git, a tarball install, a
#    machine with no git) it just does nothing.
#  - It never overrides a core.hooksPath you set yourself to something
#    other than .githooks -- so if you've deliberately pointed git
#    somewhere else (Husky, a different hooks setup, etc.), this leaves
#    that alone instead of silently switching it back.

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  exit 0
fi

current=$(git config --get core.hooksPath 2>/dev/null || true)

case "$current" in
  '' | .githooks)
    git config core.hooksPath .githooks
    ;;
  *)
    echo "[setup-hooks] core.hooksPath is already set to '$current' -- leaving it alone." >&2
    echo "[setup-hooks] Run 'git config core.hooksPath .githooks' if you want this repo's hooks (including the pre-push Claude review) instead." >&2
    ;;
esac
