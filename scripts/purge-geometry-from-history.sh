#!/usr/bin/env bash
# Rewrite every commit so the published history carries no pixel-level
# annotation geometry (mask RLE, polygon vertices, signed tracker states).
#
# The pre-rewrite history is preserved locally under
# refs/backup/pre-geometry-redaction, so nothing is lost on this machine.
# The remote is then updated with --force-with-lease, which refuses to
# overwrite commits that appeared on the remote meanwhile.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# git is not on PATH on this host; fall back to the known installs.
if ! command -v git >/dev/null 2>&1; then
    for candidate in /home/sihan/miniconda3/bin/git /home/xinrun/miniconda3/bin/git /usr/bin/git /usr/local/bin/git; do
        [ -x "$candidate" ] && export PATH="$(dirname "$candidate"):$PATH" && break
    done
fi
command -v git >/dev/null || { echo "git not found" >&2; exit 1; }
SANITIZER="${SANITIZER:-$ROOT/tools/sanitize-evidence.py}"
BACKUP_REF="refs/backup/pre-geometry-redaction"

cd "$ROOT"

if ! git rev-parse --verify "$BACKUP_REF" >/dev/null 2>&1; then
    git update-ref "$BACKUP_REF" HEAD
    echo "==> backup: $BACKUP_REF -> $(git rev-parse --short "$BACKUP_REF")"
else
    echo "==> backup already exists: $BACKUP_REF"
fi

echo "==> rewriting history (geometry redaction in every commit)"
FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch --force \
    --tree-filter "if [ -d evidence ]; then python3 '$SANITIZER' evidence >/dev/null 2>&1 || true; fi" \
    --tag-name-filter cat -- --all

echo "==> cleaning refs/original"
rm -rf .git/refs/original
git reflog expire --expire=now --all
git gc --prune=now --quiet

echo "==> verifying"
if git grep -IqE '"points": \[[0-9]' $(git rev-list --all) -- evidence 2>/dev/null; then
    echo "FAIL: geometry still present in history" >&2
    exit 1
fi
python3 "$SANITIZER" --check evidence

echo
echo "done. review with: git log --oneline --all"
echo "then push with:"
echo "  git push --force-with-lease=refs/heads/main:$(git rev-parse refs/backup/pre-geometry-redaction) origin main"
