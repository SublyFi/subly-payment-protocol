#!/usr/bin/env bash
# Set up a detached rehearsal: register the agent wallet and liquidity policy,
# seed the position through manual sync, then activate it with signerProvider.
# With the detached facilitator running, execute from the repository root:
#   bash demo/setup-detached.sh
set -euo pipefail

FACILITATOR="${SUBLY_FACILITATOR_URL:-http://localhost:3000}"
ADMIN="${SUBLY_ADMIN_API_TOKEN:-dev-admin}"
KEYPAIR="${SUBLY_DEMO_AGENT_KEYPAIR_PATH:-demo/env/keys/agent-detached.json}"
WALLET="$(solana-keygen pubkey "$KEYPAIR")"

echo "facilitator: $FACILITATOR"
echo "agent wallet: $WALLET"

post() {
  local path="$1" body="$2"
  echo
  echo "POST $path"
  curl -sS -X POST "$FACILITATOR$path" \
    -H "authorization: Bearer $ADMIN" \
    -H "content-type: application/json" \
    -d "$body"
  echo
}

post /v1/wallets/agent "{\"wallet\":\"$WALLET\",\"signingPolicyId\":\"demo\",\"signingMode\":\"non_interactive\",\"signerValidationMode\":\"structured_intent_transaction\"}"

post /v1/admin/liquidity-policies '{"sellerClass":"default","expectedPaymentSizeRawUsdc":"10000","minInstantLiquidityRawUsdc":"0","targetBudgetIlliquidRate":1}'

# Seed shares worth 100 USDC at exchange rate 1.1 => 10 USDC spendable yield.
post "/v1/wallets/$WALLET/sync" '{"totalSharesRaw":"100000000","exchangeRateScaled":"1100000000000","instantRedeemCapacityRawUsdc":"1000000000","principalBasisRawUsdc":"100000000","principalBasisSource":"manual_trusted_seed"}'

post /v1/wallets/agent "{\"wallet\":\"$WALLET\",\"signingPolicyId\":\"demo\",\"signingMode\":\"non_interactive\",\"signerValidationMode\":\"structured_intent_transaction\",\"signerProvider\":\"local-keypair\",\"activateForPayments\":true}"

echo
echo "done: run the buyer to display the budget, then reach 402 -> prepare -> transaction_builder_unavailable"
