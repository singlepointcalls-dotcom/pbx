#!/bin/bash
set -euo pipefail

# Only run in Claude Code on the web (remote environments)
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# Install npm dependencies — required for `npm test` (node:test) to find modules
# `npm install` (not `npm ci`) to take advantage of cached node_modules across runs
npm install --no-audit --no-fund
