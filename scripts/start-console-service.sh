#!/bin/zsh
set -euo pipefail

export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

cd "$(dirname "$0")/.."
mkdir -p ".runtime"
exec > ".runtime/server.log" 2>&1

exec npm run start
