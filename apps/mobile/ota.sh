#!/usr/bin/env bash
# Publish an over-the-air (JavaScript-only) update to an installed build.
#
#   pnpm ota                          # staging, message = last commit subject
#   pnpm ota "Fix login error text"   # staging, custom message
#   CHANNEL=production pnpm ota "..."  # another channel (needs a matching build + variant)
#
# Only JS/asset changes can go over the air. If you changed native dependencies or app.config.ts
# native settings, bump `version` in app.config.ts and build a new APK instead (docs/MOBILE.md).
set -euo pipefail

cd "$(dirname "$0")"

CHANNEL="${CHANNEL:-staging}"
case "$CHANNEL" in
  staging | production) ;;
  *) echo "CHANNEL must be 'staging' or 'production' (got '$CHANNEL')" >&2; exit 1 ;;
esac
export APP_VARIANT="$CHANNEL"

MESSAGE="${1:-$(git log -1 --pretty=%s)}"

if [ -n "$(git status --porcelain -- . ../../packages/shared)" ]; then
  echo "Warning: uncommitted changes in apps/mobile or packages/shared will be included in this update." >&2
fi

echo "Building @videochat/shared (the app bundles its compiled output)..."
pnpm --filter @videochat/shared build

echo "Publishing update to channel '$CHANNEL': $MESSAGE"
npx eas-cli update --channel "$CHANNEL" --message "$MESSAGE" --non-interactive

echo
echo "Done. On the phone: open the app, close it completely, open it again (first launch downloads, second applies)."
