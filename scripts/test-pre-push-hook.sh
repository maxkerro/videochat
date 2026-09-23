#!/bin/sh
# Exercises .githooks/pre-push against fake `claude`/`pnpm` shims in
# scratch git repos, covering the branches most likely to regress
# quietly: a root commit, a branch delete, a multi-ref push, a force-push
# over a remote tip this repo has never fetched, and a decorated verdict
# line. Run with: sh scripts/test-pre-push-hook.sh
#
# Assumes non-interactive execution (CI, or this Cowork sandbox): the
# hook's confirm_push() opens /dev/tty directly, so if this is run at a
# real interactive terminal it may stop to ask for a y/N confirmation
# instead of proceeding on its own.
set -eu

repo_root=$(cd "$(dirname "$0")/.." && pwd)
hook="$repo_root/.githooks/pre-push"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

bin="$work/bin"
mkdir -p "$bin"
cat >"$bin/pnpm" <<'EOF'
#!/bin/sh
[ "${1:-}" = typecheck ] && exit 0
exit 0
EOF
chmod +x "$bin/pnpm"

new_repo() {
  # $1 = name; echoes the local working copy's path
  d="$work/$1"
  mkdir -p "$d/remote.git" "$d/local/.githooks"
  git init --bare -q "$d/remote.git"
  git init -q "$d/local"
  git -C "$d/local" config user.email t@t.com
  git -C "$d/local" config user.name Test
  git -C "$d/local" remote add origin "$d/remote.git"
  cp "$hook" "$d/local/.githooks/pre-push"
  chmod +x "$d/local/.githooks/pre-push"
  git -C "$d/local" config core.hooksPath .githooks
  echo "$d/local"
}

set_claude() {
  # $1 = full shell script body for the fake `claude`
  printf '%s\n' "$1" >"$bin/claude"
  chmod +x "$bin/claude"
}

run_push() {
  # $1 = repo dir, remaining args = passed straight to `git push`
  d="$1"
  shift
  (cd "$d" && PATH="$bin:$PATH" git push "$@")
}

echo "== root commit is reviewed and reaches confirmation =="
r=$(new_repo case1)
set_claude '#!/bin/sh
cat >/dev/null
echo "VERDICT: OK"'
echo a >"$r/a.txt"
git -C "$r" add a.txt
git -C "$r" commit -q -m c1
out=$(run_push "$r" origin HEAD:refs/heads/main 2>&1) || fail "root commit push failed: $out"
echo "$out" | grep -q "Reviewing 1 commit" || fail "root commit was not reviewed: $out"
echo "$out" | grep -q "No new commits to review" && fail "root commit was wrongly treated as nothing to review: $out"

echo "== branch delete is skipped (claude is never invoked) =="
r=$(new_repo case2)
set_claude '#!/bin/sh
echo "unexpected claude invocation for a branch delete" >&2
exit 1'
echo a >"$r/a.txt"
git -C "$r" add a.txt
git -C "$r" commit -q -m c1
run_push "$r" origin HEAD:refs/heads/main >/dev/null 2>&1 || fail "initial push for case2 failed"
out=$(run_push "$r" origin --delete main 2>&1) || fail "branch delete push failed: $out"
echo "$out" | grep -q "No new commits to review" || fail "branch delete did not report nothing to review: $out"

echo "== multi-ref push reviews every ref =="
r=$(new_repo case3)
count_file="$work/case3_count"
: >"$count_file"
set_claude "#!/bin/sh
cat >/dev/null
echo x >> '$count_file'
echo 'VERDICT: OK'"
git -C "$r" checkout -q -b main
echo a >"$r/a.txt"
git -C "$r" add a.txt
git -C "$r" commit -q -m c1
git -C "$r" checkout -q -b feature
echo b >"$r/b.txt"
git -C "$r" add b.txt
git -C "$r" commit -q -m c2
run_push "$r" origin main feature >/dev/null 2>&1 || fail "multi-ref push failed"
calls=$(wc -l <"$count_file" | tr -d ' ')
[ "$calls" = "2" ] || fail "expected claude to run twice for a 2-ref push, ran $calls time(s)"

echo "== force-push over an unfetched remote tip still gets reviewed =="
r=$(new_repo case4)
set_claude '#!/bin/sh
cat >/dev/null
echo "VERDICT: OK"'
echo a >"$r/a.txt"
git -C "$r" add a.txt
git -C "$r" commit -q -m c1
run_push "$r" origin HEAD:refs/heads/main >/dev/null 2>&1 || fail "initial push for case4 failed"
# Simulate "someone else force-pushed and I never fetched": a second clone
# advances the remote past what $r's local repo knows about, so the
# remote_sha the hook receives on the next push is a real, non-zero sha
# this local repo has never heard of as an object.
other="$work/case4-other"
git clone -q "$work/case4/remote.git" "$other" 2>/dev/null
git -C "$other" config user.email o@o.com
git -C "$other" config user.name Other
# The bare remote has no default branch set, so the clone above doesn't
# check anything out ("remote HEAD refers to nonexistent ref") -- make
# sure this clone's working branch is actually based on the commit $r
# pushed, not an unrelated new root commit (which would be a real,
# legitimate non-fast-forward rejection and not the scenario being tested).
git -C "$other" checkout -q -B main origin/main
echo other >"$other/other.txt"
git -C "$other" add other.txt
git -C "$other" commit -q -m other
git -C "$other" push -q origin HEAD:refs/heads/main
git -C "$r" commit -q --allow-empty -m c2-local-only
out=$(run_push "$r" origin --force HEAD:refs/heads/main 2>&1) || true
echo "$out" | grep -q "No new commits to review" && fail "force-push over an unknown remote tip was silently skipped: $out"
echo "$out" | grep -qi "review" || fail "force-push over an unknown remote tip did not trigger a review: $out"

echo "== decorated verdict lines are recognized =="
r=$(new_repo case5)
echo a >"$r/a.txt"
git -C "$r" add a.txt
git -C "$r" commit -q -m c1
set_claude '#!/bin/sh
cat >/dev/null
printf "No issues.\n**VERDICT: OK**  \r\n"'
run_push "$r" origin HEAD:refs/heads/main >/dev/null 2>&1 || fail "decorated OK verdict incorrectly blocked the push"

git -C "$r" commit -q --allow-empty -m c2
set_claude '#!/bin/sh
cat >/dev/null
printf "Problem found.\n**VERDICT: BLOCK**\r\n"'
block_log="$work/case5_block.log"
if run_push "$r" origin HEAD:refs/heads/main >"$block_log" 2>&1; then
  fail "decorated BLOCK verdict did not block the push"
fi
grep -q "Opus flagged a blocking-severity issue" "$block_log" || fail "decorated BLOCK verdict was not recognized: $(cat "$block_log")"

echo "All pre-push hook tests passed."
