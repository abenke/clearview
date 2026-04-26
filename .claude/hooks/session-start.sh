#!/bin/bash
set -euo pipefail

# Only run inside Claude Code on the web — local sessions manage their own deps.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

npm install
npm run compile
