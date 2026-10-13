#!/usr/bin/env bash
# Builds the staging APK. Runs from anywhere: eas must see apps/mobile/eas.json.
set -e
cd "$(dirname "$0")"
npx eas-cli build --platform android --profile staging
