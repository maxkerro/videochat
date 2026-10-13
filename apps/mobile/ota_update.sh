#!/usr/bin/env bash
# Usage: ./ota_update.sh "message"   (CHANNEL=production ./ota_update.sh "message" for production)
exec bash "$(dirname "$0")/ota.sh" "$@"
