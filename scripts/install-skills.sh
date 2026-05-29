#!/usr/bin/env bash
# Symlink the share-handoff / ingest-handoff skills into your Claude Code skills dir.
# Re-running is safe (idempotent). Use `--copy` to copy instead of symlink.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"
MODE="${1:-symlink}"

mkdir -p "$DEST"
for skill in share-handoff ingest-handoff; do
  src="$REPO_DIR/skills/$skill"
  dst="$DEST/$skill"
  rm -rf "$dst"
  if [[ "$MODE" == "--copy" ]]; then
    cp -R "$src" "$dst"
    echo "copied  $skill -> $dst"
  else
    ln -s "$src" "$dst"
    echo "linked  $skill -> $dst"
  fi
done

chmod +x "$REPO_DIR/skills/share-handoff/publish.sh"
echo
echo "Done. In any Claude Code session you can now say:  \"hand off this session\""
echo "Tip: export HANDOFF_ENDPOINT=https://your-domain  to publish to your own service."
