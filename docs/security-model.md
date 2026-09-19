# Security and trust model

Subly 0.x is beta software. There is no external security audit or guarantee of principal, yield, availability or recovery. This release includes source review and regression tests; those do not replace an independent audit or operator validation.

## What holds funds and who signs

USDC is deposited into a Kamino vault. The agent wallet controls its vault shares. The relayer holds a sponsor key used for gas and account rent, not the agent key. Local signers load their key in the client process; Circle/Privy sign through the configured provider. The owner passkey or separate owner wallet approves an **off-chain** spending mandate. It is not a second on-chain signature on every payment.

The relayer cannot normally withdraw agent funds without the agent signature. However, an agent key can transact outside Subly and bypass Subly's policies. A compromised client, signer provider, RPC, relayer, underlying program or dependency may defeat the intended controls. Use a dedicated agent wallet with limited funds and a relayer you trust.

## Transaction checks

The client pins vault, share mint, farm and asset locally. It checks allowed instructions, accounts, amounts, transaction hash and fee limits before signing. Deposits bind to the caller's requested amount and allow exactly one KVault deposit. Withdrawals bind to the requested purpose and use the client's RPC to simulate the prepared transaction; the net USDC received by the agent ATA must match the request within 10 raw units of rounding. Unsupported/unavailable simulation fails closed. Simulation describes the state at that moment, not a guarantee of later execution or principal accounting.

The relayer validates the wallet signature and exact prepared message, rechecks the active mandate/approval at submission, co-signs with its sponsor, and broadcasts. Revocation cannot cancel a transaction already signed and broadcast. Instruction allowlists are additional protection; the protocol's principal basis and yield calculations still depend on the relayer.

## Yield and owner controls

Spendable yield accounts for recorded principal basis, reservations, safety buffer and sponsor fee debt. Principal basis is off-chain accounting stored in PostgreSQL; it cannot always be reconstructed from chain. External share transfers may require a conservative baseline reset and discard accrued budget. Vault losses, USDC depegging, curator actions and program exploits can reduce principal value.

Mandates and approvals are scoped to `(wallet, vault)`. The default enforced policy requires owner approval for deposits and allows normal withdrawals. Owners may require withdrawal approval. A revoked mandate blocks new relayer operations including withdrawals; replacing it with the same owner credential or following the recovery flow may be necessary. Recovery revoke has a 72-hour grace period. Expired mandates fall back to the documented default policy; they are not an on-chain freeze. Operators must keep `SUBLY_MANDATE_ENFORCEMENT=on` for intended policy enforcement.

## Two transactions and uncertain outcomes

Yield realization and the seller's x402 payment are not atomic. Realized USDC can remain in the wallet after a failed payment. The client persists pending outcomes before allowing later attempts, and uses an exclusive local file lock across CLI/MCP processes. Do not delete pending state to force a retry. File locks do not coordinate different hosts, files, or applications that bypass this client. The relayer is not the seller's x402 facilitator and cannot guarantee fulfillment by a seller.

## Operator and dependency boundaries

HTTPS, PostgreSQL backups, sponsor key permissions and trusted RPC configuration are operator responsibilities. Capability links contain authorization context: keep them out of public logs, issues and analytics. Admin tokens permit privileged accounting actions and must not be distributed to users. Forwarded headers are trusted only in the provided private proxy topology; do not expose the relayer port publicly with `SUBLY_TRUST_PROXY=1`.

The published client and source relayer have different dependency graphs. See [dependency status](dependencies.md) for audit results, pinned dependency replacements and their verification scope. The legacy `subly-yield-exact` seller scheme is disabled by default and is not the npm client's standard x402 payment path.

Report vulnerabilities privately under [SECURITY.md](../SECURITY.md).
