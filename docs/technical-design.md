# Subly Kamino Yield Payment Technical Design

最終更新: 2026-06-10 JST

このドキュメントを現在の技術設計の正とする。

## Goal

Subly は、ユーザまたは AI エージェントの wallet が `Subly USDC Payment Vault Alpha` に USDC を預け、その Kamino Curator Vault で発生した yield を HTTP API 決済に使えるようにする。決済 UX は x402 に近い `402 -> sign -> retry -> settle -> API response` だが、支払い原資は wallet の通常 USDC 残高ではなく Kamino Vault share の redeem で実現した yield とする。

目指す体験:

- AI エージェントが HTTP 経由で Subly Vault に deposit / withdraw できる。
- 同じ agent wallet が Kamino UI から deposit した資金も、Subly が同じ wallet position として同期できる。
- 支払い時は seller が USDC を受け取り、Subly はその支払いが yield budget 内だったことを検証して attest する。
- ユーザが agent wallet に手動 top-up し続けるのではなく、Vault yield が継続的な支払い余力になる。

## Non-goals

- Subly 独自 Vault または新規 on-chain program の作成。
- Privacy / TEE / Arcium。
- Kamino yield を claimable token として扱う設計。
- Agent wallet から元本を絶対に動かせない on-chain 制約。
- Subly-owned USDC pool から seller へ立替払いする treasury/credit 型 settlement。

Subly が保証するのは「Subly 経由の API 決済が、現在の Kamino position、Subly ledger、transaction simulation から計算した yield budget 内で実行された」こと。On-chain に残る事実は、agent wallet が Kamino Vault shares を redeem し、seller が USDC を受け取ったことだけである。Yield budget 内だったことは Subly facilitator attestation であり、on-chain cryptographic proof ではない。

MVP の product claim は `yield-budgeted agent payments` とする。Agent wallet が通常 wallet として元本を withdraw できることは受け入れるが、Subly payment flow は `principal_basis + safety_buffer` を下回る redeem/settlement を作らない。将来「agent が元本を技術的に動かせない」ことを保証したくなった場合だけ、Subly Guard Program、PDA custody、または Guard delegate model を追加する。

## Core Decisions

- `scheme = subly-yield-exact` を定義し、標準 x402 Solana `exact` は名乗らない。
- x402 v2 の HTTP transport、headers、`PaymentRequired` / `PaymentPayload` / `SettlementResponse` 形状を再利用し、x402 と同じ `402 -> sign -> retry -> settle -> API response` 体験を提供する。
- Agent wallet が USDC と Kamino Vault shares を保有する。Subly は wallet key を預からない。
- Facilitator が canonical transaction を組み立て、agent wallet signer が policy 下で自動署名し、facilitator が fee payer として最後に署名して送信する。
- Seller payment source は決済ごとの `Temporary Settlement USDC Account` に限定する。Agent の通常 USDC ATA から seller に直接送らない。
- Kamino withdraw が即時 USDC 化できる場合だけ settlement する。Queue に入る場合は `budget_illiquid` で拒否し、seller には API response を返さない。
- Deposit、normal withdraw、wallet sync も HTTP API として提供する。
- Payment settlement yield redeem と、agent が任意に元本/残高を戻す normal withdraw は別フローとする。

## Vault

```text
Vault name:     Subly USDC Payment Vault Alpha
Vault address:  5kfkpQZ6AkQgizHVThqkxD4J3db2i7pE3mHdPNRbx7jr
Program ID:     KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd
Deposit token:  USDC
USDC mint:      EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
Share mint:     7hGX49So539MU9Rrah8nBNVYXswWVwEJvgWNYeBDYq3a
Lookup table:   7UbXhDnpK7WVnwsfivzQRENoqKqAULQ5s19gS1xJrQEo
Vault farm:     E2Ct77LowkDAH1T9ubwPpb84pU2GSGrUdgH3KeTTpLX
```

Kamino Vault facts:

- Depositor は USDC を deposit し、Vault share/kToken を受け取る。
- Yield は share count の増加ではなく exchange rate の上昇として反映される。
- `position_value = total_user_shares * exchange_rate`。
- `total_user_shares = staked_shares + unstaked_shares`。Vault farm があるため share ATA だけを正にしてはいけない。
- Withdraw は unallocated buffer と reserve liquidity で足りる場合に即時完了する。不足分は withdrawal queue に入る可能性がある。
- API payment は即時 settlement が必要なので queued withdraw は使わない。

Kamino data handling:

- Payment-critical current state は SDK/on-chain state と simulation を正にする。
- Kamino public API は P&L/cost basis、history、monitoring、reconciliation に使う。
- `GET /kvaults/vaults/{vault}` の `state.tokenAvailable`、`state.sharesIssued`、`state.prevAum` は raw atomic-unit strings として扱う。
- `GET /kvaults/users/{user}/positions/{vault}` の `stakedShares`、`unstakedShares`、`totalShares` は decimal strings として raw share units に変換する。
- `GET /kvaults/users/{user}/vaults/{vault}/pnl` と `/pnl/history` の USDC/token values は decimal strings として raw USDC units に変換する。
- Adapter response には `sourceEndpoint`、`fieldPath`、`observedAt` または `observedSlot`、`rawValue`、`unitKind`、`normalizedRawUnits` を持たせる。
- Budget code は adapter 済み raw integer だけを読む。Kamino JSON を直接 parse しない。

## Actors And Trust

- `Agent Wallet`: USDC と Kamino Vault shares を保有する Solana wallet。Subly payment、deposit、normal withdraw の authority。
- `Agent Wallet Signer`: HSM/MPC/KMS/embedded wallet/server-side signer など。人間の per-payment approval なしで署名できるが、policy と transaction 内容を検証してから署名する。
- `Subly Facilitator`: Canonical transaction author、budget verifier、fee sponsor、settlement submitter。Agent wallet key は持たない。
- `Seller`: x402-like 402 response を返し、retry 時に Subly `/verify` と `/settle` を呼ぶ。Kamino integration は不要。
- `Subly Budget Ledger`: `principal_basis`、reservations、fee debt、idempotency、wallet sync status、receipts を管理する。

Wallet rules:

- Browser extension wallet の per-transaction popup 前提では自律決済にならない。
- 同じ wallet が Kamino UI から deposit した場合、その wallet に approved agent signer があれば Subly payment budget に同期できる。
- 別の personal wallet で deposit した position は、approved signer/delegation がない限り `observed_only` とし、自律支払いには使わない。
- Agent wallet は通常 wallet なので元本 withdraw 自体は可能。Subly は Subly 経由の支払いが yield budget 内であることだけを制御する。
- SPL Token delegate だけでは、yield budget、seller allowlist、Kamino withdraw、one-transaction settlement invariant を表現できない。MVP は full agent wallet signer を前提にし、on-chain principal guard は MVP に含めない。

## Signer Policy

Signer は `preparedMessageHash` だけを承認材料にしてはいけない。署名前に structured intent と Solana transaction を突き合わせる。これは launch blocker であり、non-interactive signer は transaction message を decode して、意図した Kamino withdraw、temporary settlement account、seller payment、dust sweep、close、memo だけが含まれていることを検証してから署名する。

Minimum payment intent fields:

```text
paymentId, sellerRequestId, wallet, network,
httpMethod, canonicalResourceUrl, requestBodyHash, requestBindingHash,
vault, shareMint, asset, amountRawUsdc, payTo, sellerUsdcAta,
feePayer, temporarySettlementTokenAccount, dustRecipientUsdcAta,
maxSharesToRedeem, memo, expiresAt
```

`sellerRequestId` is required and must be unique for the seller's priced request. `requestBodyHash` is the SHA-256 hash of the canonical request body, or the SHA-256 hash of empty bytes for bodyless requests. `requestBindingHash` is derived from `sellerRequestId`, HTTP method, canonical URL, request body hash, seller, asset, amount, and payTo. This prevents a signed payment for one request, invoice, tenant, method, URL, or body from being replayed for another.

Payment signing must reject mismatches in:

- wallet, network, Vault, share mint, USDC mint
- seller wallet/ATA, amount, seller request ID, HTTP method, canonical URL, request body hash, request binding hash
- temporary settlement account, dust recipient ATA, close destination
- fee payer, Compute Budget instructions, memo, expiry
- max shares to redeem and prepared message hash

Deposit and normal withdraw use separate intents and validation:

- Deposit intent validates wallet, Vault, share mint, USDC mint, source USDC ATA, amount, fee payer, memo, expiry, message hash.
- Withdraw intent validates wallet, Vault, share mint, USDC mint, destination agent USDC ATA, requested/max shares, `instant_only`, fee payer, Compute Budget, expiry, message hash.
- A signer that can only blindly sign prepared bytes is not launch-ready. Local dev keypair may be used only for simulation/devnet, but any mainnet automated signer must enforce the validation rules above.

Provider-specific behavior stays behind an `AgentWalletSigner` abstraction. Privy server-side signers, MPC/HSM/KMS signers, or a local dev keypair can implement that boundary, but launch custody must not depend on raw private keys in an app database.

## Budget Accounting

All accounting uses raw integers. USDC and Subly Vault shares are currently 6-decimal assets. Do not use JavaScript `number` for money, shares, exchange rate, or oracle math.

```text
position_value_raw_usdc =
  floor(total_user_shares_raw * exchange_rate_scaled / RATE_SCALE)

gross_yield_raw_usdc =
  max(0, position_value_raw_usdc - principal_basis_raw_usdc)

spendable_yield_raw_usdc =
  max(
    0,
    gross_yield_raw_usdc
    - reserved_raw_usdc
    - fee_debt_raw_usdc
    - safety_buffer_raw_usdc
  )

shares_to_redeem_raw =
  ceil(required_withdraw_raw_usdc * RATE_SCALE / exchange_rate_scaled)
```

Rounding:

- Values that increase spendable budget are rounded down.
- Values that increase cost, share burn, fee debt, or safety reserve are rounded up.

`principal_basis_raw_usdc` is the protected baseline for the wallet's current remaining Kamino position. Preferred sources:

1. Current Kamino P&L/cost-basis API for `(wallet, vault)`, normalized to raw USDC.
2. Kamino transaction/P&L history parsed into remaining-position cost basis.
3. Subly-confirmed deposit, payment, and withdraw receipts.
4. Conservative activation/reset baseline: set `principal_basis = current_position_value`.

Subly may increase or confirm `principal_basis` from trusted current data. It must not lower `principal_basis` merely because stale or partial history makes existing principal look like yield. If data is unavailable, stale, inconsistent, or movement cannot be classified, run a conservative reset:

```text
expire prepared-but-unsubmitted payment intents
refresh current shares and exchange rate
principal_basis_raw_usdc = current_position_value_raw_usdc
reserved_raw_usdc = 0 after expiring non-submitted reservations
status = active after reset is recorded
```

Submitted payments keep the wallet locked until terminal status before reset.

Payment invariant:

```text
post_position_value_raw_usdc
  - other_active_reservations_raw_usdc
  - current_estimated_fee_debt_raw_usdc
  - fee_debt_raw_usdc
  >= principal_basis_raw_usdc + safety_buffer_raw_usdc
```

`other_active_reservations_raw_usdc` excludes the current seller payment because the current withdraw is already reflected in `post_position_value_raw_usdc`.

Concurrency:

- Serialize `/payments/prepare`, `/x402/settle`, `/withdrawals/prepare`, and wallet sync per `(wallet, vault)`.
- Use PostgreSQL row locks/advisory locks, Redis with fencing token, or optimistic versioning with retry.
- Reservations and terminal status changes must be idempotent.

## Fee Sponsorship

Subly sponsor wallet is the Solana fee payer. Fee sponsorship pays SOL fees only; it does not replace the agent wallet authority signature.

```text
fee_debt_raw_usdc =
  ceil(sol_fee_lamports * SOL_USDC_PRICE_SCALED / (LAMPORTS_PER_SOL * PRICE_SCALE))
```

Rules:

- `/prepare` reserves estimated fee debt with base fees, priority fees, and a buffer.
- Landed transactions apply actual fee debt once from confirmed metadata, even if the transaction failed on-chain.
- Non-landed expiry, preflight failure, or send failure releases reservation without fee debt.
- Temporary token account rent is not charged as fee debt because the account closes to the sponsor in the same transaction.
- Oracle data for SOL/USDC must be fresh and capped by policy.
- Signing policy must cap `max_estimated_fee_lamports`, compute limit, compute unit price, and `max_fee_debt_raw_usdc_per_payment`.

In x402 `SettlementResponse`, top-level `payer` is the Subly sponsor because it is the transaction fee payer. The agent wallet appears in `extensions.subly.agentWallet`.

## x402-Like HTTP Protocol

Subly reuses the x402 v2 HTTP transport shape:

- HTTP `402 Payment Required`
- `PAYMENT-REQUIRED` header with base64 JSON `PaymentRequired`
- `PAYMENT-SIGNATURE` header with base64 JSON `PaymentPayload`
- `PAYMENT-RESPONSE` header with base64 JSON `SettlementResponse`
- Facilitator-like `/supported`, `/verify`, `/settle`
- x402 client/facilitator scheme registration shape

Subly adds:

- `scheme = subly-yield-exact`
- `POST /v1/payments/prepare`
- Canonical Kamino withdraw + seller transfer transaction builder
- Yield budget ledger and liquidity gate
- `paymentId` generated by Subly, not by seller
- `requestBindingHash` for seller request, method, canonical URL, body hash, amount, asset, and payee binding
- `preparedMessageHash` matching and duplicate settlement cache

Generic x402 facilitators will not support this scheme. Sellers accepting Subly payments must point to the Subly facilitator and check `/supported`.

This is intentional. Standard x402 Solana `exact` is a narrow SPL token transfer scheme and cannot express Kamino withdraw + seller transfer in one settlement transaction. Subly keeps the x402-style HTTP payment experience while using a custom settlement scheme.

Flow:

```text
1. Agent calls paid seller API.
2. Seller returns 402 with accepts[].scheme = subly-yield-exact and a unique sellerRequestId.
3. Subly client selects that requirement and calls POST /v1/payments/prepare.
4. Facilitator validates request binding, policy, budget, liquidity, builds canonical transaction, and stores paymentId.
5. Agent wallet signer validates intent + transaction and signs.
6. Agent retries seller request with PAYMENT-SIGNATURE.
7. Seller forwards to Subly /verify and /settle.
8. Facilitator verifies exact prepared message, signs as fee payer, submits or reconciles, and returns SettlementResponse.
9. Seller returns protected API response only after /settle succeeds.
```

`paymentId` is the canonical Subly settlement idempotency key and is generated by Subly. `sellerRequestId` is the seller's required request/invoice key and is part of `requestBindingHash`; it is not a substitute for `paymentId`.

`POST /v1/payments/prepare` must receive the selected `PaymentRequirements` plus request metadata from the client SDK: HTTP method, canonical resource URL, and request body hash. The facilitator recomputes `requestBindingHash`, stores it with the payment intent, and rejects any retry whose payload or seller-forwarded requirements do not match that stored binding.

## Settlement Transaction

Prerequisites:

- Seller USDC ATA exists.
- Agent USDC ATA exists for dust sweep.
- Agent wallet has approved signer policy.
- Wallet position is not `needs_baseline_reset`.
- Spendable yield and instant redeem capacity cover seller amount, withdrawal penalty/fee, estimated fee debt, and buffers.

Transaction shape:

```text
fee payer: Subly sponsor
signers:   agent wallet
           Subly sponsor
           fresh Temporary Settlement USDC Account keypair

instructions:
  ComputeBudget set limit
  ComputeBudget set price
  System create account for Temporary Settlement USDC Account
  SPL Token initialize account:
    mint = USDC
    owner/authority = agent wallet
  Kamino farm unstake instructions when required
  KVault low-level withdraw/withdrawFromAvailable:
    user = agent wallet
    userSharesAta = agent Vault share ATA
    userTokenAta = Temporary Settlement USDC Account
  SPL Token TransferChecked:
    source = Temporary Settlement USDC Account
    destination = seller USDC ATA
    authority = agent wallet
    amount = seller amount
  optional SPL Token TransferChecked dust:
    source = Temporary Settlement USDC Account
    destination = agent USDC ATA
    authority = agent wallet
  SPL Token CloseAccount:
    account = Temporary Settlement USDC Account
    destination = Subly sponsor
    authority = agent wallet
  Memo paymentId
```

Invariants:

- The temporary token account is a fresh non-ATA token account generated for one payment.
- Its token authority and close authority are the agent wallet.
- Its rent close destination is the Subly sponsor because the sponsor funded account creation.
- The account did not exist before the transaction and must close in the same transaction.
- `Kamino withdraw destination == seller TransferChecked source == Temporary Settlement USDC Account`.
- Seller receives exactly `amount` raw USDC.
- Any extra USDC from rounding or withdrawal penalty handling is swept to the agent USDC ATA before close.
- Sponsor may be fee payer and close lamport recipient only. It must not be token authority, token source, token destination, Kamino share authority, or unexpected writable account.

Implementation notes:

- Kamino withdraw amount is shares, not USDC. Compute `shares_to_redeem_raw` from current exchange rate, seller amount, withdrawal penalty/fee, and rounding buffer.
- High-level `vault.withdrawIxs(...)` is acceptable for normal wallet withdraw only when it withdraws to the agent ATA and does not enqueue. Payment settlement must use low-level KVault instructions so `userTokenAta` can be the temporary account.
- KVault withdraw may require reserve and lending-market remaining accounts even when current liquidity is in `tokenAvailable`.
- Use versioned transactions and the Vault lookup table when account count approaches Solana transaction size limits.
- Settlement simulation must verify share burn, withdraw output, seller transfer, dust sweep, temporary account close, sponsor role, and post-state invariant.

Known validation note:

- A 2026-06-09 JST mainnet simulation against this Vault confirmed the critical path: create non-ATA USDC account, withdraw from KVault into that account, transfer to seller, and leave the temporary account at zero. The simulation required Vault reserve remaining accounts and a withdrawal-penalty-aware redeem amount.

## Liquidity Policy

Kamino can serve withdrawals from:

1. Unallocated Vault liquidity.
2. Available liquidity in standard allocations.
3. Withdrawal queue.

Subly API payment uses only paths 1 and 2. If the required redeem would queue:

- Return `budget_illiquid`.
- Release no seller access.
- Do not advance USDC from a Subly treasury pool.
- Do not submit a transaction that is expected to enqueue; payment settlement is `instant_only`.

Launch configuration per seller class:

```text
expected_payment_size_raw_usdc
min_instant_liquidity_raw_usdc
target_budget_illiquid_rate
```

`/v1/payments/prepare` checks both:

```text
spendable_yield_raw_usdc >= seller_amount + estimated_fee_debt
instant_redeem_capacity_raw_usdc >= required_withdraw_raw_usdc
```

`spendable_yield_raw_usdc` already subtracts `safety_buffer_raw_usdc`; `/prepare` must not add the same buffer a second time.

The curator must operate the Vault with enough unallocated buffer and redeemable reserve liquidity for expected API payment sizes. Higher buffer improves payment availability but lowers yield.

Future compatibility mode may maintain a small realized-yield USDC buffer and use standard x402 Solana `exact` for sellers that do not support `subly-yield-exact`. That mode is optional and separate from the MVP custom settlement path.

## Deposit And Withdraw

Deposit through Subly:

```text
POST /v1/deposits/prepare
POST /v1/deposits/submit
GET  /v1/deposits/{deposit_id}
```

Subly builds a Kamino deposit transaction, the agent signer validates and signs, Subly submits, and principal basis increases only after confirmed on-chain deltas prove the actual USDC deposited and shares minted.

Deposit through Kamino UI:

- Supported when the same wallet has an approved agent signer.
- Subly syncs `totalShares` and P&L/cost-basis for `(wallet, vault)`.
- The deposit increases cost basis. It is not spendable yield at deposit time.
- If current P&L/cost-basis data is reliable, Subly may include already-accrued yield above cost basis in spendable budget.
- If history is unavailable, stale, or inconsistent, set current position value as baseline and wait for new yield. This still supports same-wallet Kamino UI deposits, but only yield accrued after the conservative sync becomes spendable.

Normal withdraw through Subly:

```text
POST /v1/withdrawals/prepare
POST /v1/withdrawals/submit
GET  /v1/withdrawals/{withdrawal_id}
```

Rules:

- Destination is the agent wallet's normal USDC ATA.
- Mode is `instant_only`; queued withdraws are rejected as `withdraw_illiquid`.
- Prepared but unsubmitted payment intents expire before normal withdraw preparation.
- Submitted payments keep the wallet locked until terminal settlement.
- Confirmed normal withdraw reduces current position and either updates principal basis exactly or runs conservative baseline reset.

Kamino UI withdraw or external share movement:

- Exact classification updates basis conservatively.
- Ambiguous movement sets `needs_baseline_reset` and blocks new payments until reset.
- No-signer personal wallet positions remain `observed_only`.

## API Surface

```text
GET  /v1/x402/supported
POST /v1/x402/verify
POST /v1/x402/settle

POST /v1/payments/prepare
GET  /v1/payments/{payment_id}

POST /v1/deposits/prepare
POST /v1/deposits/submit
GET  /v1/deposits/{deposit_id}

POST /v1/withdrawals/prepare
POST /v1/withdrawals/submit
GET  /v1/withdrawals/{withdrawal_id}

POST /v1/wallets/agent
POST /v1/wallets/{wallet}/signing-policy
POST /v1/wallets/{wallet}/sync
GET  /v1/wallets/{wallet}/budget
```

Minimum persistent state:

```text
wallet_positions:
  wallet, vault, signing_policy_id, signing_mode, signer_provider,
  staked_shares_raw, unstaked_shares_raw, total_shares_raw,
  principal_basis_raw_usdc, principal_basis_source,
  reserved_raw_usdc, fee_debt_raw_usdc,
  kamino_position_snapshot_json, kamino_pnl_snapshot_json,
  last_synced_slot, version, status

payment_intents:
  payment_id, wallet, vault, seller, seller_request_id,
  http_method, canonical_resource_url, request_body_hash, request_binding_hash,
  seller_usdc_ata, dust_recipient_usdc_ata,
  amount_raw_usdc, signing_policy_id, prepared_message_hash,
  recent_blockhash, last_valid_block_height, intent_json,
  temporary_settlement_token_account, temporary_settlement_signature,
  shares_to_redeem_raw, required_withdraw_raw_usdc,
  estimated_fee_lamports, estimated_fee_debt_raw_usdc,
  principal_basis_before_raw_usdc, gross_yield_before_raw_usdc,
  spendable_yield_before_raw_usdc, post_position_value_raw_usdc,
  reservation_raw_usdc, status, expires_at, submitted_at,
  terminal_at, tx_signature, settlement_response_json

deposit_intents:
  deposit_id, wallet, vault, amount_raw_usdc, prepared_message_hash,
  actual_deposit_raw_usdc, shares_minted_raw,
  principal_basis_before_raw_usdc, principal_basis_after_raw_usdc,
  status, expires_at, tx_signature

withdrawal_intents:
  withdrawal_id, wallet, vault, requested_shares_raw,
  requested_withdraw_raw_usdc, destination_usdc_ata,
  prepared_message_hash, recent_blockhash, last_valid_block_height,
  max_shares_to_redeem_raw, actual_shares_burned_raw,
  actual_withdraw_raw_usdc, principal_basis_before_raw_usdc,
  principal_basis_after_raw_usdc, status, expires_at,
  submitted_at, terminal_at, tx_signature, liquidity_rejection_reason

seller_liquidity_policies:
  seller_class, vault, expected_payment_size_raw_usdc,
  min_instant_liquidity_raw_usdc, target_budget_illiquid_rate, status

sync_events:
  wallet, vault, event_type, tx_signature, delta_shares_raw,
  delta_principal_raw_usdc, classification, source_endpoint,
  raw_snapshot_json, slot
```

## Verification And Settlement

`/verify` and `/settle` accept only a transaction whose message hash was produced by `/v1/payments/prepare`.

Before signing as fee payer, facilitator verifies:

1. Requirement and policy: scheme, network, USDC mint, Vault/share mint, request binding, seller/resource/amount limits, daily cap, signer provider status.
2. Intent state: `paymentId` exists, maps to exactly one `requestBindingHash`, reservation is active, expiry and blockhash are valid, retries are idempotent.
3. Prepared message: transaction message is byte-for-byte identical to the prepared message except signatures; agent and temporary account signatures are valid.
4. Settlement path: exact instruction layout, expected writable accounts only, temporary account invariant, seller amount/destination, no extra token transfers.
5. Simulation and budget: simulation succeeds and post-state principal invariant holds.

Submission is idempotent:

- Under the `(wallet, vault)` lock, sign as fee payer, submit once, store `tx_signature`, mark `submitted`.
- Poll confirmation outside the lock.
- Reacquire the lock for terminal state, release reservation, apply actual fee debt if landed, and store receipt or error.
- Retrying `/settle` for a `submitted`, `settled`, `failed`, `expired`, or `failed_not_submitted` payment must never build or submit a second transaction.

Common terminal errors:

```text
insufficient_yield
budget_illiquid
seller_ata_missing
agent_usdc_ata_missing
policy_violation
stale_oracle
fee_cap_exceeded
message_hash_mismatch
simulation_failed
needs_baseline_reset
expired
failed_not_submitted
landed_failed
```

Seller delivery policy is settle-before-deliver. Seller grants API access only after direct Subly `/settle` success. Unsigned receipt data relayed by the agent is not trusted.

Settlement response keeps x402 top-level fields and places Subly-specific proof details under `extensions.subly`:

```json
{
  "success": true,
  "transaction": "solanaSignature",
  "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "payer": "sublySponsorPubkey",
  "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "amount": "10000",
  "extensions": {
    "subly": {
      "paymentId": "pay_...",
      "sellerRequestId": "seller_req_...",
      "requestBindingHash": "sha256-...",
      "httpMethod": "GET",
      "canonicalResourceUrl": "https://api.example.com/v1/data",
      "requestBodyHash": "sha256-empty",
      "agentWallet": "agentWalletPubkey",
      "payTo": "sellerWalletPubkey",
      "vault": "5kfkpQZ6AkQgizHVThqkxD4J3db2i7pE3mHdPNRbx7jr",
      "temporarySettlementTokenAccount": "tempTokenAccountPubkey",
      "sharesRedeemedRaw": "10042",
      "withdrawOutputRawUsdc": "10000",
      "sellerTransferRawUsdc": "10000",
      "dustTransferRawUsdc": "0",
      "principalBasisBeforeRawUsdc": "100000000",
      "grossYieldBeforeRawUsdc": "25000",
      "spendableYieldBeforeRawUsdc": "15000",
      "postPositionValueRawUsdc": "100015000",
      "fundingMode": "kamino_jit_yield"
    }
  }
}
```

The receipt proves the on-chain USDC transfer through `transaction`, `temporarySettlementTokenAccount`, `sharesRedeemedRaw`, `withdrawOutputRawUsdc`, and `sellerTransferRawUsdc`. The statement that the payment was yield-budget-compliant is Subly's attestation.

## MVP Scope

MVP means the complete end-to-end product path below, not a staged prototype that defers production-critical controls:

- Agent-controlled wallet with non-interactive signer.
- Signer-side validation adapters for payment, deposit, and normal withdraw.
- Typed Kamino adapter with endpoint-specific unit normalization and provenance.
- Wallet position sync from total shares, exchange rate, P&L/cost basis, and on-chain deltas.
- Yield budget ledger with principal baseline, reservations, fee debt, safety buffer, conservative reset, and serialized locks.
- Subly deposit and instant-only normal withdraw HTTP flows.
- Custom x402-like `subly-yield-exact` client, seller middleware, facilitator scheme, `/supported`, `/verify`, `/settle`.
- Canonical settlement transaction using fresh Temporary Settlement USDC Account, low-level Kamino withdraw, seller transfer, dust sweep, close, and memo.
- Idempotent `paymentId`, required seller `sellerRequestId`, `requestBindingHash`, prepared message hash matching, replay protection, terminal-state reconciliation.
- Liquidity gate, seller-class liquidity policy, sponsor SOL monitoring, stale oracle/fee cap handling, simulation failure monitoring, settlement latency metrics, and alerts.
- One controlled seller API and one controlled agent wallet on mainnet with small USDC amounts for launch validation.

## Launch Readiness

No High/Middle launch blocker remains when all checks below pass:

1. Vault has yield-producing capital, verified non-zero yield accrual or deployed allocation, and enough instant redeem capacity for expected seller payment size. Deposit balance alone is not sufficient readiness.
2. Seller class has `expected_payment_size_raw_usdc`, `min_instant_liquidity_raw_usdc`, and `target_budget_illiquid_rate`.
3. Agent wallet signer is non-interactive after onboarding and validates transaction contents before signing.
4. Every payment binds `paymentId` to exactly one `requestBindingHash`, including seller request ID, method, canonical URL, body hash, amount, asset, and payee.
5. Same-wallet Kamino UI deposits are included through `totalShares` and P&L/cost-basis sync; unreliable history triggers conservative baseline reset rather than treating unknown value as yield.
6. Personal-wallet positions without approved signer are `observed_only`.
7. Same-wallet UI withdraws and unknown share movements are classified or force conservative reset.
8. Budget reservations, settlement, withdraw preparation, and sync are serialized per `(wallet, vault)`.
9. Seller and agent USDC ATAs exist before payment settlement; payment settlement never creates them.
10. `/settle` accepts only the stored prepared message hash with valid agent and temporary account signatures.
11. Retry paths never submit a second transaction for one `paymentId`.
12. Landed failed transactions apply fee debt once; non-landed failures do not.
13. Simulation verifies temporary account zero balance/close and post-state principal invariant.
14. Seller grants access only after direct `/settle` success.

## Validation Plan

1. Register one agent wallet, non-interactive signer, and signing policy.
2. Verify Kamino adapter treats Vault `state.*` raw fields and user position/P&L decimal fields correctly.
3. Confirm Subly deposit and same-wallet Kamino UI deposit both update `totalShares` and basis conservatively; existing accrued yield is spendable only when reliable cost-basis data proves it.
4. Confirm no-signer personal wallet positions become `observed_only`.
5. Confirm normal withdraw is instant-only, withdraws to agent USDC ATA, expires non-submitted payment reservations, and updates/resets basis.
6. Trigger same-wallet UI withdraw and unknown share movement; confirm exact classification or `needs_baseline_reset`.
7. Confirm `/prepare` rejects missing ATAs, policy violations, stale oracle, fee cap violation, insufficient yield, and insufficient instant liquidity.
8. Confirm concurrent prepare/settle/withdraw/sync cannot double-reserve yield or update basis out of order.
9. Confirm signer-side validation rejects modified seller, seller request ID, HTTP method, canonical URL, body hash, ATA, amount, Vault, temp account, dust recipient, close destination, fee payer, Compute Budget, memo, shares, expiry, or hash.
10. Confirm `/verify` and `/settle` reject modified transaction messages and accept only the prepared message.
11. Confirm `/settle` handles prepared, submitted, settled, failed, expired, and failed-not-submitted states idempotently.
12. Settle a small mainnet payment and return x402-like `PAYMENT-RESPONSE` with Subly receipt details under `extensions.subly`.

## Sources

- Kamino Vault model: https://kamino.com/docs/curators/vaults/concepts/how-vaults-work
- Kamino liquidity and withdrawals: https://kamino.com/docs/curators/vaults/concepts/liquidity-and-withdrawals
- Kamino Vault data: https://kamino.com/docs/build/developers/earn/data/vault-data
- Kamino user position API: https://kamino.com/docs/build/kamino-earn-user/get-user-position-for-a-specific-kvault
- Kamino user PnL API: https://kamino.com/docs/build/kamino-earn-user/get-user-kvault-pnl
- Kamino user PnL history API: https://kamino.com/docs/build/kamino-earn-user/get-user-kvault-pnl-history
- Kamino withdraw operation: https://kamino.com/docs/build/developers/earn/operations/withdraw
- Kamino klend-sdk Vault helper: https://github.com/Kamino-Finance/klend-sdk/blob/master/src/classes/vault.ts
- Kamino KVault withdraw instruction: https://github.com/Kamino-Finance/klend-sdk/blob/master/src/@codegen/kvault/instructions/withdraw.ts
- Kamino KVault withdrawFromAvailable instruction: https://github.com/Kamino-Finance/klend-sdk/blob/master/src/@codegen/kvault/instructions/withdrawFromAvailable.ts
- x402 v2 specification: https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md
- x402 v2 HTTP transport: https://github.com/x402-foundation/x402/blob/main/specs/transports-v2/http.md
- x402 SVM exact scheme: https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_svm.md
- Solana transactions: https://solana.com/docs/core/transactions
- Solana transaction structure and signatures: https://solana.com/docs/core/transactions/transaction-structure
- Solana SPL Token `TransferChecked`: https://solana.com/docs/tokens/basics/transfer-tokens
- Solana fee abstraction: https://solana.com/docs/payments/send-payments/payment-processing/fee-abstraction
- Privy server-side wallet access: https://docs.privy.io/wallets/wallets/server-side-access
- Privy Solana transaction signing: https://docs.privy.io/wallets/using-wallets/solana/sign-a-transaction
