#!/usr/bin/env bash
# Sponsor SOL balance / facilitator health check for cron. Alerts a webhook
# (Slack/Discord-compatible {"text": ...}) when the facilitator is down or
# the sponsor balance is below SUBLY_MIN_SPONSOR_BALANCE_LAMPORTS.
#
#   SUBLY_FACILITATOR_URL=https://facilitator.example.com \
#   SUBLY_ADMIN_API_TOKEN=... \
#   SUBLY_ALERT_WEBHOOK_URL=https://hooks.slack.com/... \
#   bash scripts/check-sponsor-balance.sh
#
# Cron example (every 10 minutes):
#   */10 * * * * cd /opt/subly && SUBLY_FACILITATOR_URL=... SUBLY_ADMIN_API_TOKEN=... SUBLY_ALERT_WEBHOOK_URL=... bash scripts/check-sponsor-balance.sh >> /var/log/subly-monitor.log 2>&1
set -uo pipefail

FACILITATOR="${SUBLY_FACILITATOR_URL:-http://localhost:3000}"
ADMIN="${SUBLY_ADMIN_API_TOKEN:?SUBLY_ADMIN_API_TOKEN is required}"
WEBHOOK="${SUBLY_ALERT_WEBHOOK_URL:-}"

alert() {
  local message="$1"
  echo "$(date -u +%FT%TZ) ALERT: $message"
  if [ -n "$WEBHOOK" ]; then
    curl -fsS -m 15 -X POST "$WEBHOOK" \
      -H "content-type: application/json" \
      -d "{\"text\":\"[subly] $message\"}" >/dev/null ||
      echo "$(date -u +%FT%TZ) webhook delivery failed"
  fi
}

body=$(curl -fsS -m 20 "$FACILITATOR/v1/admin/monitoring" \
  -H "authorization: Bearer $ADMIN" 2>/dev/null)
if [ -z "$body" ]; then
  alert "facilitator unreachable at $FACILITATOR"
  exit 1
fi

result=$(printf '%s' "$body" | python3 -c '
import json, sys
sponsor = json.load(sys.stdin).get("sponsor")
if sponsor is None:
    print("none")
elif sponsor["belowMinimum"]:
    sol = int(sponsor["balanceLamports"]) / 1e9
    print(f"low {sponsor[\"address\"]} {sol:.4f}")
else:
    print("ok")
' 2>/dev/null)

case "$result" in
  ok)
    echo "$(date -u +%FT%TZ) sponsor balance ok"
    ;;
  none)
    alert "facilitator is running without sponsor monitoring (detached mode?)"
    exit 1
    ;;
  low*)
    alert "sponsor SOL balance below minimum: ${result#low }"
    exit 1
    ;;
  *)
    alert "unexpected monitoring response from $FACILITATOR"
    exit 1
    ;;
esac
