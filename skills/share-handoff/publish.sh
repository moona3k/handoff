#!/usr/bin/env bash
# share-handoff / publish.sh
# Scan a handoff markdown file for secrets, then publish it and print a share URL.
#
# Usage:
#   publish.sh <file> [--endpoint URL] [--public-paste] [--gist] [--ttl SECS] [--force] [--desc "text"]
#
# Backend resolution (first match wins):
#   --gist                 -> secret GitHub gist (private, durable, versioned)
#   --public-paste         -> https://paste.rs/ (no account, short URL, PUBLIC)
#   --endpoint URL / $HANDOFF_ENDPOINT  -> your own handoff Worker
#   (default)              -> secret GitHub gist
#
# Set HANDOFF_ENDPOINT=https://your-domain to make your Worker the default backend,
# or persist it to ~/.config/handoff/endpoint (used when the env var isn't set —
# handy because non-interactive shells don't source ~/.zshrc).
#
# Requires: gh (authenticated) for gist mode; curl for paste/endpoint modes.

set -euo pipefail

FILE=""
FORCE=0
DESC=""
TTL=""
ENDPOINT="${HANDOFF_ENDPOINT:-}"
MODE=""   # gist | paste | endpoint  (empty = auto)

while [[ $# -gt 0 ]]; do
  case "$1" in
    --gist)         MODE="gist"; shift ;;
    --public-paste) MODE="paste"; shift ;;
    --endpoint)     ENDPOINT="${2:-}"; MODE="endpoint"; shift 2 ;;
    --ttl)          TTL="${2:-}"; shift 2 ;;
    --force)        FORCE=1; shift ;;
    --desc)         DESC="${2:-}"; shift 2 ;;
    -*)             echo "unknown option: $1" >&2; exit 2 ;;
    *)              FILE="$1"; shift ;;
  esac
done

[[ -n "$FILE" ]] || { echo "ERROR: no file given. usage: publish.sh <file> [--endpoint URL|--public-paste|--gist]" >&2; exit 2; }
[[ -f "$FILE" ]] || { echo "ERROR: file not found: $FILE" >&2; exit 2; }

# Fall back to a saved endpoint if not set via $HANDOFF_ENDPOINT or --endpoint.
# (Claude Code's non-interactive shell doesn't source ~/.zshrc, so we persist it here.)
if [[ -z "$ENDPOINT" ]]; then
  CFG="${XDG_CONFIG_HOME:-$HOME/.config}/handoff/endpoint"
  [[ -f "$CFG" ]] && ENDPOINT="$(tr -d '[:space:]' < "$CFG")"
fi

# Resolve backend if not explicitly chosen.
if [[ -z "$MODE" ]]; then
  if [[ -n "$ENDPOINT" ]]; then MODE="endpoint"; else MODE="gist"; fi
fi

# --- secret scan -------------------------------------------------------------
scan() {
  grep -nEi \
    -e '(secret|token|passwd|password|api[_-]?key|access[_-]?key|client[_-]?secret|bearer)["'"'"' ]*[:=][ "'"'"']*[A-Za-z0-9/_+-]{16,}' \
    -e 'AKIA[0-9A-Z]{16}' \
    -e '-----BEGIN [A-Z ]*PRIVATE KEY-----' \
    -e 'gh[pousr]_[A-Za-z0-9]{20,}' \
    -e 'sk-[A-Za-z0-9]{20,}' \
    -e 'xox[baprs]-[A-Za-z0-9-]{10,}' \
    "$FILE" || true
}

HITS="$(scan)"
if [[ -n "$HITS" && "$FORCE" -ne 1 ]]; then
  {
    echo "✋ Possible secrets detected — NOT publishing."
    echo "Review/redact these lines, or re-run with --force if they are false positives:"
    echo "$HITS"
  } >&2
  exit 1
fi

# --- publish -----------------------------------------------------------------
case "$MODE" in
  endpoint)
    command -v curl >/dev/null || { echo "ERROR: curl not found" >&2; exit 1; }
    [[ -n "$ENDPOINT" ]] || { echo "ERROR: no endpoint (set HANDOFF_ENDPOINT or pass --endpoint URL)" >&2; exit 1; }
    Q=""; [[ -n "$TTL" ]] && Q="?ttl=$TTL"
    HDR="$(mktemp)"
    URL="$(curl -fsS -D "$HDR" --data-binary @"$FILE" "${ENDPOINT%/}/${Q}")"
    DKEY="$(grep -i '^x-delete-key:' "$HDR" | tr -d '\r' | awk '{print $2}')"
    rm -f "$HDR"
    echo "Published (your handoff service):"
    echo "  raw      : $URL"
    echo "  rendered : ${URL}?view"
    [[ -n "$DKEY" ]] && echo "  delete   : curl -X DELETE -H \"X-Delete-Key: $DKEY\" $URL"
    ;;
  paste)
    command -v curl >/dev/null || { echo "ERROR: curl not found" >&2; exit 1; }
    URL="$(curl -fsS --data-binary @"$FILE" https://paste.rs/)"
    echo "Published (PUBLIC — paste.rs):"
    echo "  raw      : $URL"
    echo "  rendered : ${URL}.md"
    ;;
  gist)
    command -v gh >/dev/null || { echo "ERROR: gh not found (needed for gist mode; or use --public-paste / --endpoint)" >&2; exit 1; }
    [[ -n "$DESC" ]] || DESC="context handoff $(date +%Y-%m-%d)"
    GIST_URL="$(gh gist create "$FILE" -d "$DESC")"   # secret by default
    GIST_ID="$(basename "$GIST_URL")"
    RAW_URL="$(gh api "gists/$GIST_ID" --jq '.files[].raw_url')"
    echo "Published (SECRET gist — private, durable, versioned):"
    echo "  page : $GIST_URL"
    echo "  raw  : $RAW_URL"
    ;;
esac
