# Subly Demo Notes

The current demo path pays existing standard x402 sellers from the buyer's
vault yield. The API must offer a Solana USDC `exact` rail with a facilitator
`extra.feePayer`.

Follow the [client setup guide](../packages/pay/README.md) before running the
recommended demo:

```bash
npx -y @subly_fi/pay@0.8.4 fetch <standard-x402-url> [maxAmountRawUsdc]
```

The seller needs no Subly integration: it receives a normal x402 USDC payment.
On the buyer side, Subly checks spendable yield, realizes the required amount,
and then makes the standard x402 payment. EVM-only challenges and Solana
challenges without a fee payer are rejected before any yield is moved. The
relayer also rejects a `purpose: "yield_realize"` withdrawal that exceeds
spendable yield; that check is not left solely to the client.

The MCP server (`npx -y @subly_fi/pay@0.8.4 mcp`, or the environment-loading
wrapper `demo/run-mcp.sh`) exposes `deposit_to_subly_vault`,
`withdraw_from_subly_vault` and `get_subly_yield_budget` alongside payment.
An agent can use MCP for the deposit → budget check → payment → withdrawal
lifecycle. With the required relayer and facilitator sponsorship, the agent
wallet does not need SOL for gas.

`demo/seller.ts`, `demo/buyer.ts` and `demo/pay.ts` are legacy demos for the
previous `subly-yield-exact` / hosted-seller validation path. They are not the
current demo or product introduction. Their npm scripts are
`demo:legacy:seller`, `demo:legacy:buyer` and `demo:legacy:pay`.
