#!/usr/bin/env bash
# Onboards one beta participant's agent wallet (operator-run, admin token).
# The participant only shares their PUBLIC key; private keys never move.
#
# Run AFTER the participant has deposited (the chain sync then finds their
# vault shares and activation starts from the real position):
#
#   SUBLY_FACILITATOR_URL=https://facilitator.example.com \
#   SUBLY_ADMIN_API_TOKEN=... \
#   bash scripts/onboard-agent.sh <agent wallet pubkey>
#
# --with-policy additionally upserts the "default" liquidity policy; only use
# it on first-time setup of a fresh facilitator (it overwrites the existing
# policy for ALL wallets).
set -euo pipefail

WITH_POLICY=0
if [ "${1:-}" = "--with-policy" ]; then
  WITH_POLICY=1
  shift
fi
WALLET="${1:-}"
if [ -z "$WALLET" ]; then
  echo "usage: bash scripts/onboard-agent.sh [--with-policy] <agent wallet pubkey>" >&2
  exit 1
fi

FACILITATOR="${SUBLY_FACILITATOR_URL:-http://localhost:3000}"
ADMIN="${SUBLY_ADMIN_API_TOKEN:?SUBLY_ADMIN_API_TOKEN is required}"

post() {
  local path="$1" body="$2"
  echo
  echo "POST $path"
  curl -fsS -X POST "$FACILITATOR$path" \
    -H "authorization: Bearer $ADMIN" \
    -H "content-type: application/json" \
    -d "$body"
  echo
}

echo "facilitator:  $FACILITATOR"
echo "agent wallet: $WALLET"

if [ "$WITH_POLICY" = "1" ]; then
  post /v1/admin/liquidity-policies \
    '{"sellerClass":"default","expectedPaymentSizeRawUsdc":"10000","minInstantLiquidityRawUsdc":"0","targetBudgetIlliquidRate":1}'
fi

post /v1/wallets/agent \
  "{\"wallet\":\"$WALLET\",\"signingPolicyId\":\"demo\",\"signingMode\":\"non_interactive\",\"signerValidationMode\":\"structured_intent_transaction\"}"

post "/v1/wallets/$WALLET/sync" '{"source":"chain"}'

post /v1/wallets/agent \
  "{\"wallet\":\"$WALLET\",\"signingPolicyId\":\"demo\",\"signingMode\":\"non_interactive\",\"signerValidationMode\":\"structured_intent_transaction\",\"signerProvider\":\"local-keypair\",\"activateForPayments\":true}"

echo
echo "done: wallet is registered, synced from chain, and activated."
echo "Check the budget with:"
echo "  curl -s $FACILITATOR/v1/wallets/$WALLET/budget -H 'authorization: Bearer \$SUBLY_ADMIN_API_TOKEN'"
