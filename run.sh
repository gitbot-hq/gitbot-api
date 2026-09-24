#!/usr/bin/env bash
# Post-deploy hook for `pm2 deploy ecosystem.config.cjs uat`. Runs on the server
# inside the checked-out source directory.
set -euo pipefail

export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm use v22.17.0
node --version

cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo "ERROR: .env is missing in $(pwd). Copy .env.example, set ADMIN_SECRET, PORT=7000 and DB_PATH, then redeploy." >&2
  exit 1
fi

# Build needs devDependencies (typescript). better-sqlite3 downloads a prebuilt binary for node 22.
npm ci --include=dev
npm run build
npm prune --omit=dev

pm2 startOrReload ecosystem.config.cjs --update-env
pm2 save
