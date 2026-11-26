#!/usr/bin/env bash
# Install this checkout as the machine's m1das command (a copy, not a link, so later edits do not reach the running
# gateway), then (re)start the service. Extra arguments go to m1das service install, for example --system.
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo"
npm run build
tarball=$(npm pack --silent)
trap 'rm -f "$repo/$tarball"' EXIT
npm install -g --no-audit --no-fund "$repo/$tarball"
m1das service install "$@"
m1das status
