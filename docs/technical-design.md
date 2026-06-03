# Subly Yield-Funded Payment Protocol Technical Design

最終更新: 2026-05-28 JST

## Goal

Subly は、AI エージェントが持つ USDC を Kamino Curator Vault に預け、そこで発生した yield だけをサードパーティ API や x402-like payment の支払いに使う。ユーザの元本は payment engine から見て protected principal として扱い、通常の決済では取り崩さない。

この MVP では privacy / TEE / Arcium は扱わない。まずは実際の Kamino Vault と実際の USDC 決済を使って、yield-funded payment が成立することを示す。

対象 Vault:

- Name: `Subly USDC Payment Vault Alpha`
- Vault state: `5kfkpQZ6AkQgizHVThqkxD4J3db2i7pE3mHdPNRbx7jr`
- KVault program: `KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd`
- Deposit token: USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`
- Share mint: `7hGX49So539MU9Rrah8nBNVYXswWVwEJvgWNYeBDYq3a`
- Public URL: https://kamino.com/curators/vaults/5kfkpQZ6AkQgizHVThqkxD4J3db2i7pE3mHdPNRbx7jr?tab=Vault+Overview

2026-05-28 JST 時点で Kamino public API では、Vault はまだ実質的に初期化直後の小さい TVL に見える。投資家デモでは十分な元本を入れるか、メインネットの小額実決済とローカル/mock の高速デモを分ける。

## Key Design Decision

Kamino Vault の yield は、ユーザに別トークンとして配られるのではなく、share token/kToken の exchange rate 上昇として表現される。したがって Subly は「yield token」を直接支払うのではなく、以下を行う。

1. Agent wallet が Vault share を保有する。
2. Subly が wallet ごとの principal floor を記録する。
3. 現在の Vault position value から principal floor と buffer を引いた額だけを spendable yield とする。
4. 決済前に spendable yield を USDC に realize し、その USDC で x402 / x402-like payment を行う。

重要な式:

```text
position_value = vault_shares * vault_exchange_rate
total_value = position_value + realized_yield_usdc + pending_withdraw_usdc
spendable_yield = max(0, total_value - principal_floor - reserved_amount - safety_buffer)
```

決済 invariant:

```text
After every payment:
  position_value + realized_yield_usdc + pending_withdraw_usdc >= principal_floor + safety_buffer
```

この invariant を破る決済は拒否する。

## Wallet Model

MVP は Agent-owned wallet mode を採用する。

- AI エージェントが Solana wallet `W_agent` を持つ。
- ユーザは Subly 経由、または Kamino UI 経由で同じ `W_agent` を使って `Subly USDC Payment Vault Alpha` に deposit する。
- Vault share は `W_agent` に紐づく。Vault farm に auto-stake される場合でも、Kamino SDK/API の user shares query を正とする。
- Subly payment engine は `W_agent` の署名権限を使って、yield realization と API payment を行う。

Kamino UI deposit をサポートする条件:

- ユーザが Kamino UI で deposit するときの wallet が、Subly に登録された `W_agent` と同じであること。
- ユーザ自身の別 wallet に deposit しただけでは、Subly はその share を使って支払えない。別 wallet を使う場合は、後続フェーズで token delegate / smart account / Subly Guard Program が必要。

本番では private key を通常の backend DB に置かない。MPC wallet、embedded wallet、HSM、TEE、または session-key 付き smart account を使い、agent に許可する操作を Vault withdraw と USDC payment に限定する。

## System Components

### 1. Kamino Vault Adapter

責務:

- Vault metadata を読む。
- `KaminoVault.getUserShares(user)` と `KaminoVault.getExchangeRate()` で position value を計算する。
- Kamino API または SDK で deposit transaction を作る。
- SDK の `withdrawIxs` で share を burn し USDC を受け取る。
- withdrawal が queue に入った場合は status を追跡する。

推奨:

- deposit は Kamino REST API の `POST /ktx/kvault/deposit` でもよい。API は unsigned transaction を返し、wallet が署名する。
- withdraw は SDK を優先する。Kamino docs では `withdrawIxs` の amount は redeem する vault shares とされているため、USDC amount から share amount への変換を Subly 側で明示する。
- すべての mainnet transaction は送信前に simulate する。

### 2. Position Indexer

責務:

- Subly 経由 deposit と Kamino UI 経由 deposit の両方を検出する。
- `W_agent` の Vault share 増減、USDC 増減、KVault program transaction を index する。
- Kamino UI で発生した deposit は、transaction meta の pre/post token balances から USDC deposit amount を復元し、principal floor に加算する。
- 既存 wallet を import した場合は、初期同期時点の position value を principal floor に設定する。過去の yield を retroactive に使える扱いにはしないのが MVP では安全。

### 3. Yield Accountant

責務:

- wallet ごとに principal floor、realized yield buffer、reserved amount、spent amount を管理する。
- spendable yield を計算する。
- platform fee を yield から控除する。

Subly fee:

- Pitch Deck の business model は yield の 10%。
- MVP では Kamino Vault の performance fee ではなく、Subly payment engine 側で `yield_take_rate_bps = 1000` を適用する。
- 理由: Vault-level performance fee は Subly 決済を使わない depositor にも影響しうる。決済 protocol の有効性検証では、まず payment flow 内の fee として扱う方が説明しやすい。

### 4. Yield Realizer

責務:

- API 決済のたびに Vault から withdraw しない。
- `W_agent` の USDC ATA に realized yield buffer を維持する。
- しきい値を超えたときだけ、Vault share を burn して USDC を補充する。

例:

```text
target_buffer = max(1.00 USDC, expected_24h_api_spend)
refill_threshold = 0.25 USDC
if realized_yield_usdc < refill_threshold and spendable_yield >= target_buffer:
  shares_to_burn = ceil(target_buffer / exchange_rate)
  simulate withdraw
  send withdraw
  update buffer from actual USDC balance delta
```

Kamino Vault は、利用可能な liquidity が不足すると withdrawal queue を使うことがある。Subly は queued withdraw を即時決済原資として扱わない。queued amount は `pending_withdraw_usdc` として追跡し、USDC が実際に wallet に届いた後に payment buffer に入れる。

決済用 Vault allocation の推奨:

- 最大 APY よりも withdrawal liquidity を優先する。
- 5-10% 程度の unallocated buffer を持つ。
- fixed-rate / 高 utilization reserve への偏りは、withdrawal queue の運用ができるまで抑える。
- whitelisted reserves と multisig admin を使う。
- investor demo では、allocation と liquidity risk を dashboard で見せる。

### 5. Payment Engine

責務:

- Agent からの outbound API request を受け取る。
- x402 / x402-like の 402 response を読み、payment requirements を検証する。
- domain allowlist、max price、daily cap、token/network、recipient を policy で検査する。
- spendable yield と realized buffer を確認する。
- USDC payment を署名し、request を retry する。
- receipt、transaction signature、payment id を保存する。

MVP の支払い方式:

1. Third-party が Solana x402 を受け付ける場合:
   - `W_agent` から merchant の `payTo` へ USDC SPL transfer。
   - x402 client は `exact` scheme を優先する。
   - Solana network identifier は x402 docs の CAIP-2 形式を使う。

2. Third-party が x402 非対応の場合:
   - Subly Proxy が既存 API key / billing で third-party を呼ぶ。
   - Agent から Subly Proxy への支払いを x402-like にする。
   - これは protocol demo としては有効だが、permissionless seller integration ではないため、資料では明確に分ける。

3. Usage-based API:
   - Solana x402 MVP では fixed-price `exact` を優先する。
   - usage-based は、事前 quote、max cap、または Subly Proxy の post-metered charge として扱う。
   - x402 の `upto` は便利だが、現行 docs 上は EVM 中心の機能として扱われるため、Solana MVP の必須要件にしない。

### 6. Subly API

MVP endpoints:

```text
POST /v1/wallets
  Create/register an agent wallet.

POST /v1/wallets/:wallet/deposit-intent
  Body: { amount_usdc }
  Returns unsigned Kamino deposit transaction.

POST /v1/wallets/:wallet/sync
  Reconcile Kamino UI deposits and Vault share balances.

GET /v1/wallets/:wallet/budget
  Returns principal_floor, position_value, realized_buffer, reserved, spendable_yield.

POST /v1/wallets/:wallet/realize-yield
  Withdraw spendable yield into USDC buffer, if invariant allows it.

POST /v1/payments/quote
  Validate x402 requirements and Subly policy.

POST /v1/payments/execute
  Execute payment using realized yield buffer, retry protected API request, store receipt.

GET /v1/payments/:payment_id
  Return payment status, chain tx, and service receipt metadata.
```

### 7. SDK Surface

`subly402-sdk`:

```ts
const subly = createSublyClient({
  wallet,
  vault: "5kfkpQZ6AkQgizHVThqkxD4J3db2i7pE3mHdPNRbx7jr",
  policy: {
    maxPerRequestUsdc: "0.05",
    dailyCapUsdc: "2.00",
    allowlist: ["api.weather.example", "api.search.example"],
  },
});

const res = await subly.fetch("https://api.weather.example/current?city=Tokyo");
```

`subly402-express`:

```ts
app.use(sublyPaymentMiddleware({
  "GET /weather": {
    price: "0.01",
    asset: "USDC",
    network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    payTo: merchantWallet,
  },
}));
```

Exact package names and x402 mechanism adapters should follow the current x402 SDK used at implementation time.

## Core Flows

### Flow A: Deposit Through Subly API

1. User chooses amount.
2. Subly calls Kamino deposit transaction endpoint or SDK.
3. Wallet signs transaction.
4. Subly waits for confirmation and parses actual USDC delta.
5. `principal_floor += actual_deposit_usdc`.
6. New shares are tracked as Vault position.

### Flow B: Deposit Through Kamino UI

1. User opens Kamino UI and selects `Subly USDC Payment Vault Alpha`.
2. User deposits with the same `W_agent`.
3. Subly indexer detects share increase or KVault deposit transaction.
4. Subly parses actual deposit amount.
5. `principal_floor += actual_deposit_usdc`.
6. Future yield from the enlarged position becomes available to the AI agent.

If Subly cannot parse the exact deposit transaction, it uses the conservative fallback:

```text
principal_floor += delta_shares * exchange_rate_at_detection
```

This may undercount immediately accrued yield, but it prevents accidental principal spend.

### Flow C: Yield Realization

1. Scheduler checks budget.
2. If spendable yield is above threshold, compute shares to burn.
3. Simulate Kamino withdraw.
4. Send withdraw.
5. Update realized yield buffer from actual USDC balance delta.
6. If withdrawal queues, mark pending and do not spend until settled.

### Flow D: x402-like API Payment

1. Agent calls a paid API through Subly SDK/proxy.
2. Server returns `402 Payment Required` with requirements, or Subly Proxy has a configured price.
3. Payment Engine validates:
   - method + URL
   - payee
   - token
   - network
   - max price
   - idempotency key
   - domain policy
4. Budget Guard checks `realized_yield_usdc >= amount + fees`.
5. If buffer is too low but unrealized spendable yield exists, Subly may realize yield and retry.
6. Wallet signs USDC payment.
7. Request is retried with payment payload.
8. Receipt and tx signature are stored.
9. Ledger records `spent_yield += amount`.

Idempotency is mandatory. Use a logical `payment_id` for retries so network failures do not double-pay.

## Data Model

```text
wallet_accounts
  id
  owner_user_id
  wallet_pubkey
  vault_pubkey
  usdc_ata
  share_mint
  mode                  // agent_owned, delegated, guard_program
  created_at

principal_events
  id
  wallet_id
  type                  // deposit, principal_withdrawal, import_baseline, correction
  amount_raw_usdc
  source                // subly_api, kamino_ui, manual, indexer
  tx_signature
  slot
  created_at

vault_snapshots
  id
  wallet_id
  shares_raw
  exchange_rate
  position_value_raw_usdc
  realized_yield_raw_usdc
  pending_withdraw_raw_usdc
  principal_floor_raw_usdc
  reserved_raw_usdc
  spendable_raw_usdc
  slot
  created_at

withdrawals
  id
  wallet_id
  shares_burned_raw
  expected_usdc_raw
  actual_usdc_raw
  status                // simulated, sent, confirmed, queued, settled, failed
  tx_signature
  queue_ticket
  created_at

payment_intents
  id
  wallet_id
  payment_identifier
  merchant
  url_hash
  method
  amount_raw_usdc
  platform_fee_raw_usdc
  status                // quoted, reserved, paid, settled, failed, refunded
  x402_requirements_hash
  payment_tx_signature
  receipt_hash
  created_at
```

## Investor Demo Plan

Minimum credible demo:

1. Show `W_agent` deposits USDC into `Subly USDC Payment Vault Alpha`.
2. Show Kamino API/SDK reading shares, exchange rate, APY, and Subly budget.
3. Show `principal_floor` and `spendable_yield`.
4. Realize a small amount of yield into USDC buffer.
5. Call a paid API endpoint through Subly SDK.
6. Show USDC transfer / x402 receipt.
7. Show principal invariant still holds after payment.

Demo economics:

- At 5% APY, 1,000 USDC earns about 0.137 USDC/day, enough for roughly 13 calls/day at 0.01 USDC.
- At 10,000 USDC, the same APY earns about 1.37 USDC/day.
- Therefore a live mainnet demo should either use very cheap API calls, enough deposited principal, or a pre-accrued realized yield buffer.

Use "principal-preserving, yield-funded" instead of "free" in technical materials. The payment is free relative to principal drawdown, but it consumes opportunity yield and carries DeFi/liquidity risk.

## Phase Plan

### Phase 0: Current Vault Readiness

- Confirm Vault metadata through Kamino API.
- Confirm deposit token, share mint, min deposit, fee settings.
- Set production admin to Squads multisig before public usage.
- Ensure allocation strategy favors liquid USDC reserves and keeps a withdrawal buffer.

### Phase 1: Off-chain Principal Guard MVP

- Agent-owned wallet.
- Kamino deposit through API/SDK.
- Kamino UI deposit sync.
- Off-chain principal floor ledger.
- Yield realization scheduler.
- Solana USDC x402 exact payment or Subly Proxy payment.
- Receipts and demo dashboard.

This phase is enough to prove the protocol concept.

### Phase 2: Non-custodial / On-chain Guard

Add a Subly Guard Program only after Phase 1 proves demand.

Possible design:

- Users deposit Vault shares into a PDA controlled by Subly Guard.
- Guard stores principal floor in raw USDC.
- Guard allows `withdraw_yield` only if post-withdraw Vault value remains above principal floor plus buffer.
- Agent receives a restricted authority to request yield-only payments.

This improves trust but increases implementation cost because the program must CPI into Kamino KVault and safely read Vault state.

### Phase 3: Privacy Layer

- Move payment metadata handling into TEE or Arcium.
- Encrypt ledger metadata.
- Hide merchant/API details from public observers where possible.

Privacy is intentionally out of scope for MVP.

## Main Risks

- Yield is variable and can be too small for frequent API usage.
- Withdrawals may be delayed by Kamino liquidity constraints or withdrawal queue.
- Off-chain principal guard requires trust in Subly until Guard Program exists.
- Agent wallet custody is a real security surface.
- x402 payment and service delivery are not atomically coupled across HTTP and chain settlement.
- USDC nominal principal protection does not remove USDC depeg risk.
- Vault allocation choices can create liquidity or credit risk.
- If a user deposits from a wallet the agent does not control, Subly cannot spend the yield without delegation or a guard account.

## References

- Kamino Curator Vault overview: https://kamino.com/docs/curators/vaults/concepts/how-vaults-work
- Kamino liquidity and withdrawals: https://kamino.com/docs/curators/vaults/concepts/liquidity-and-withdrawals
- Kamino API index: https://kamino.com/docs/llms.txt
- Kamino Earn deposit API recipe: https://kamino.com/docs/build/recipes/earn/earn-via-api.md
- Kamino Earn withdraw API recipe: https://kamino.com/docs/build/recipes/earn/earn-withdraw-via-api.md
- Kamino user position data: https://kamino.com/docs/build/developers/earn/data/user-position-data.md
- x402 introduction: https://docs.x402.org/
- x402 client/server model: https://docs.x402.org/core-concepts/client-server
- x402 payment identifier / idempotency: https://docs.x402.org/extensions/payment-identifier
- x402 seller quickstart / schemes: https://docs.x402.org/getting-started/quickstart-for-sellers
