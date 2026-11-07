#!/usr/bin/env bash
# Fail if the evidence tree still contains pixel-level annotation geometry.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
python3 "$ROOT/tools/sanitize-evidence.py" --check "$ROOT/evidence"
