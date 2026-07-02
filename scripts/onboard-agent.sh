#!/usr/bin/env bash
# Operator tool: registers/re-syncs/re-activates an agent wallet via the admin
# token. Participants do NOT need this — their clients self-register with
# wallet-signature auth on first use. Keep it for manual recovery, e.g. forcing
# a chain re-sync.
#
#   SUBLY_RELAYER_URL=https://api.example.com \
#   SUBLY_ADMIN_API_TOKEN=... \
#   bash scripts/onboard-agent.sh <agent wallet pubkey>
set -euo pipefail

WALLET="${1:-}"
if [ -z "$WALLET" ]; then
  echo "usage: bash scripts/onboard-agent.sh <agent wallet pubkey>" >&2
  exit 1
fi

RELAYER="${SUBLY_RELAYER_URL:-${SUBLY_FACILITATOR_URL:-http://localhost:3000}}"
ADMIN="${SUBLY_ADMIN_API_TOKEN:?SUBLY_ADMIN_API_TOKEN is required}"

post() {
  local path="$1" body="$2"
  echo
  echo "POST $path"
  curl -fsS -X POST "$RELAYER$path" \
    -H "authorization: Bearer $ADMIN" \
    -H "content-type: application/json" \
    -d "$body"
  echo
}

echo "relayer:      $RELAYER"
echo "agent wallet: $WALLET"

post /v1/wallets/agent \
  "{\"wallet\":\"$WALLET\",\"signingPolicyId\":\"demo\",\"signingMode\":\"non_interactive\",\"signerValidationMode\":\"structured_intent_transaction\"}"

post "/v1/wallets/$WALLET/sync" '{"source":"chain"}'

post /v1/wallets/agent \
  "{\"wallet\":\"$WALLET\",\"signingPolicyId\":\"demo\",\"signingMode\":\"non_interactive\",\"signerValidationMode\":\"structured_intent_transaction\",\"signerProvider\":\"local-keypair\",\"activateForPayments\":true}"

echo
echo "done: wallet is registered, synced from chain, and activated."
echo "Check the budget with:"
echo "  curl -s $RELAYER/v1/wallets/$WALLET/budget -H 'authorization: Bearer \$SUBLY_ADMIN_API_TOKEN'"
