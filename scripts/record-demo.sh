#!/usr/bin/env bash
set -euo pipefail

if ! command -v asciinema >/dev/null 2>&1; then
  echo "asciinema is required to record the demo." >&2
  exit 1
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"
./node_modules/.bin/pnpm build

echo "The recording runs the deterministic vertical-slice integration test and never accesses provider credentials."
asciinema rec --command "./node_modules/.bin/vitest run --config vitest.config.ts apps/cli/tests/fake-vertical-slice.test.ts --reporter verbose" agent-foreman-demo.cast
