#!/usr/bin/env bash
# Publishes Pingly: public source+releases repo, the v0.1.0 release with the
# installers attached, and the private landing-page repo.
#
#   gh auth login          # once, interactive — needs a browser
#   bash scripts/publish.sh
#
# Safe to re-run: every step skips work that is already done.
set -euo pipefail

USER_NAME="${GITHUB_USER:-adarshbytes}"
APP_REPO="pingly"
SITE_REPO="pingly-site"
TAG="v0.1.0"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

GH="gh"
command -v gh >/dev/null || GH="/c/Program Files/GitHub CLI/gh.exe"

"$GH" auth status >/dev/null 2>&1 || {
  echo "Not signed in. Run:  gh auth login" >&2
  exit 1
}

echo "==> publishing as $USER_NAME"

# The download button points at releases/latest/download/Pingly-Setup.exe, so the
# asset filename must be exactly this or the landing page 404s.
for f in Pingly-Setup.exe Pingly-Portable.exe; do
  [ -f "$ROOT/dist/$f" ] || { echo "missing dist/$f — run: npm run dist" >&2; exit 1; }
done

# ---------- public repo: source + releases ----------
cd "$ROOT"
if ! "$GH" repo view "$USER_NAME/$APP_REPO" >/dev/null 2>&1; then
  echo "==> creating public repo $USER_NAME/$APP_REPO"
  "$GH" repo create "$APP_REPO" --public \
    --description "Tells you when your AI coding assistant finishes or needs you. Windows tray app." \
    --source=. --remote=origin --push
else
  echo "==> $APP_REPO exists"
  git remote get-url origin >/dev/null 2>&1 || \
    git remote add origin "https://github.com/$USER_NAME/$APP_REPO.git"
  git push -u origin main
fi

# ---------- the release ----------
# NOT a prerelease, deliberately: releases/latest/ skips prereleases, which would
# leave the download button 404ing with the release sitting right there.
if "$GH" release view "$TAG" --repo "$USER_NAME/$APP_REPO" >/dev/null 2>&1; then
  echo "==> release $TAG exists — uploading assets (clobbering)"
  "$GH" release upload "$TAG" \
    "dist/Pingly-Setup.exe" "dist/Pingly-Portable.exe" \
    --repo "$USER_NAME/$APP_REPO" --clobber
else
  echo "==> creating release $TAG"
  "$GH" release create "$TAG" \
    "dist/Pingly-Setup.exe" "dist/Pingly-Portable.exe" \
    --repo "$USER_NAME/$APP_REPO" \
    --title "Pingly $TAG" \
    --notes "$(cat <<'NOTES'
First public beta. Windows only.

**[Download Pingly-Setup.exe](../../releases/latest/download/Pingly-Setup.exe)** — or grab
the portable build if you would rather not install anything.

Pingly sits in your tray and shows a card when Claude Code, Cursor or Codex CLI
finishes or needs you, so a 20-second question never costs you 40 minutes.

- Requires Node.js — the hooks run through it.
- Not code signed yet, so Windows will say "Windows protected your PC".
  Click **More info → Run anyway**.
- Nothing leaves your machine. A local server on 127.0.0.1 and nothing else.
- Every config is backed up to `<file>.pingly-backup` before it is touched, and
  disconnecting removes only Pingly's own entries.
NOTES
)"
fi

# ---------- private landing page ----------
cd "$ROOT/site"
if ! "$GH" repo view "$USER_NAME/$SITE_REPO" >/dev/null 2>&1; then
  echo "==> creating private repo $USER_NAME/$SITE_REPO"
  "$GH" repo create "$SITE_REPO" --private \
    --description "pingly.top — landing page" \
    --source=. --remote=origin --push
else
  echo "==> $SITE_REPO exists"
  git remote get-url origin >/dev/null 2>&1 || \
    git remote add origin "https://github.com/$USER_NAME/$SITE_REPO.git"
  git push -u origin main
fi

echo
echo "==> done"
echo "    source   https://github.com/$USER_NAME/$APP_REPO"
echo "    download https://github.com/$USER_NAME/$APP_REPO/releases/latest/download/Pingly-Setup.exe"
echo "    site     https://github.com/$USER_NAME/$SITE_REPO  (import into Vercel, add pingly.top)"
