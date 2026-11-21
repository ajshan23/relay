#!/usr/bin/env bash
#
# Relay auto-deploy: the server checks GitHub every minute and deploys itself when main moves.
# GitHub never connects to the server. Runs from cron as the user that runs pm2.
#
#   scripts/auto-deploy.sh install     add the every-minute cron line (once)
#   scripts/auto-deploy.sh uninstall   remove it
#   scripts/auto-deploy.sh status      what's deployed, the last lines of the log
#   scripts/auto-deploy.sh retry       try again a commit that failed (it isn't retried on its own)
#   scripts/auto-deploy.sh             one check (what cron runs)
#
# Only does what the new commits need: pnpm install when a package.json or the lockfile changed,
# migrations when one came in, the web build when the web app or a package it uses changed, then
# reloads the Relay apps. A failing step stops the deploy before any reload; that commit is not tried
# again until a newer one arrives (or `retry`). A failed web build may already have cleared the old
# one (Next does that), so the web app can be down until the fix lands, as with a manual deploy.
#
# State and log live in ~/.relay-deploy (deployed = last good commit, failed = commit that failed).

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRANCH="${DEPLOY_BRANCH:-main}"
STATE="${DEPLOY_STATE_DIR:-$HOME/.relay-deploy}"
LOG="$STATE/deploy.log"
SELF="$REPO/scripts/auto-deploy.sh"
mkdir -p "$STATE"

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"$LOG"; }

case "${1:-run}" in
  install)
    # cron starts with a bare PATH; keep this shell's, so node, pnpm and pm2 are found.
    line="* * * * * PATH='$PATH' $SELF >/dev/null 2>&1"
    (crontab -l 2>/dev/null | grep -v 'scripts/auto-deploy.sh'; echo "$line") | crontab -
    [ -f "$STATE/deployed" ] || git -C "$REPO" rev-parse HEAD >"$STATE/deployed"
    echo "Auto-deploy on: checks origin/$BRANCH every minute. Log: $LOG"
    exit 0 ;;
  uninstall)
    (crontab -l 2>/dev/null | grep -v 'scripts/auto-deploy.sh') | crontab -
    echo "Auto-deploy off."
    exit 0 ;;
  status)
    echo "Deployed: $(cat "$STATE/deployed" 2>/dev/null || echo none)"
    [ -f "$STATE/failed" ] && echo "Failed (not retried): $(cat "$STATE/failed")"
    crontab -l 2>/dev/null | grep -q 'scripts/auto-deploy.sh' && echo "Cron: on" || echo "Cron: off"
    echo "--- last log lines ---"
    tail -n 25 "$LOG" 2>/dev/null
    exit 0 ;;
  retry) rm -f "$STATE/failed" ;;
  run) ;;
  *) echo "usage: $0 [install|uninstall|status|retry]" >&2; exit 2 ;;
esac

# One deploy at a time: a build can take longer than a minute.
exec 9>"$STATE/lock"
flock -n 9 || exit 0

cd "$REPO" || exit 1
git fetch --quiet origin "$BRANCH" 2>>"$LOG" || { log "git fetch failed"; exit 1; }
remote="$(git rev-parse "origin/$BRANCH")"
[ -f "$STATE/deployed" ] || git rev-parse HEAD >"$STATE/deployed"
deployed="$(cat "$STATE/deployed")"
[ "$remote" = "$deployed" ] && exit 0
[ "$remote" = "$(cat "$STATE/failed" 2>/dev/null)" ] && exit 0

# Everything that changed since the last good deploy (not just since HEAD: after a failed deploy
# HEAD is already ahead, and the next deploy still has to do that commit's work).
changed="$(git diff --name-only "$deployed" "$remote" 2>/dev/null || echo '*')"
has() { grep -qE "$1" <<<"$changed"; }

fail() {
  log "FAILED: $1 (${remote:0:7}). Nothing was reloaded. See the output above; push a fix or run retry."
  echo "$remote" >"$STATE/failed"
  exit 1
}
# step "label" command...  (the label is logged, never the command, so no secret reaches the log)
step() {
  local label="$1"; shift
  log "  $label"
  "$@" >>"$LOG" 2>&1 || fail "$label"
}

log "Deploying ${deployed:0:7} -> ${remote:0:7}: $(git log --format=%s -1 "$remote")"
step "git merge" git merge --ff-only --quiet "origin/$BRANCH"

if [ "$changed" = '*' ] || has '(^|/)package\.json$|^pnpm-lock\.yaml$|^pnpm-workspace\.yaml$'; then
  step "pnpm install" pnpm install --frozen-lockfile
fi

if [ "$changed" = '*' ] || has '^packages/db/migrations/'; then
  db_url="$(grep '^DATABASE_URL=' .env | cut -d= -f2-)"
  [ -n "$db_url" ] || fail "DATABASE_URL missing in .env"
  step "database migrations" env "DATABASE_URL=$db_url" pnpm --filter @relay/db migrate
fi

reload="relay-api,relay-realtime,relay-worker"
if [ "$changed" = '*' ] || has '^apps/web/|^packages/(core|ui)/|^pnpm-lock\.yaml$'; then
  step "web build" pnpm --filter @relay/web build
fi
reload="relay-web,$reload"

# The Kairos dashboard only when it runs on this server.
if pm2 describe kairos-dashboard >/dev/null 2>&1 &&
  { [ "$changed" = '*' ] || has '^apps/kairos-dashboard/|^packages/kairos/|^pnpm-lock\.yaml$'; }; then
  step "Kairos dashboard build" pnpm --filter @relay/kairos-dashboard build
  reload="$reload,kairos-dashboard"
fi

# Only docs or notes changed: nothing to restart.
if [ "$changed" != '*' ] && ! grep -qvE '^docs/|\.md$' <<<"$changed"; then
  log "  only docs changed, no restart"
else
  step "pm2 reload ($reload)" pm2 reload ecosystem.config.cjs --only "$reload"
fi

echo "$remote" >"$STATE/deployed"
rm -f "$STATE/failed"
log "Deployed ${remote:0:7}"

# Keep the log short.
tail -n 3000 "$LOG" >"$LOG.tmp" && mv "$LOG.tmp" "$LOG"
