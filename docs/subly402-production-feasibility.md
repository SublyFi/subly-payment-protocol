# Subly402 Production Feasibility

最終更新: 2026-05-29 JST

## 結論

技術的に可能。ただし Subly が作るべきものは「Kamino の yield を claim して transfer するだけの bot」ではない。

Subly が本番で作るべき protocol は次の 4 層:

1. **Yield Source**: Kamino Curator Vault に USDC を deposit し、kToken/share の exchange rate 上昇で yield を得る。
2. **Principal Guard**: 元本を on-chain に保護し、yield 相当分だけを payment budget として解放する。
3. **Payment Buffer**: API 決済に使う USDC を yield から事前に用意する。
4. **Subly402 Layer**: x402 のように HTTP `402 Payment Required`、payment requirement、policy check、receipt、idempotency を持つ API payment UX を提供する。

最も現実的な本番構成:

```text
Kamino Vault
  -> kToken/share yield accrual

Subly Guard Program
  -> holds or controls Kamino shares
  -> enforces principal floor
  -> realizes only yield into USDC

Agent Wallet
  -> holds only small USDC yield buffer
  -> signs standard SPL USDC payment for x402/Subly402

Subly Facilitator / Paymaster
  -> pays SOL fees
  -> verifies payment requirements
  -> prevents duplicate settlement
  -> stores receipts
```

この設計なら、エージェントは x402 的に API を買えるが、元本である Kamino shares には直接触れない。

## Why Not Just Claim Yield And Transfer

単に yield を USDC に戻して transfer するだけなら、Subly は「自動送金 bot」に近い。Protocol として価値が出るのは次の部分。

- API が `402` で価格・支払い先・token/network・期限を提示する。
- Agent がそれを読み、policy と budget を確認して自動支払いする。
- 支払いと API request が `payment_id` / receipt で紐づく。
- duplicate payment / replay / overpayment を防ぐ。
- fee payer を Subly が担当し、ユーザに SOL を要求しない。
- 元本は Guard によって on-chain で保護され、yield budget だけが API 決済に流れる。
- Kamino withdrawal queue に備えて、payment buffer を運用する。

つまり Subly の独自性は `yield-funded x402-like payment rail` であり、単なる `withdraw + transfer` ではない。

## Kamino Facts That Matter

Kamino Vault では、depositor は USDC を deposit し、Vault share/kToken を受け取る。yield は別 token として配られるのではなく、share の exchange rate 上昇として反映される。

```text
shares minted = deposit_amount / current_exchange_rate
position_value = shares * exchange_rate
yield_value = position_value - principal_floor
```

withdraw は常に即時とは限らない。Kamino docs の withdrawal model は:

1. unallocated buffer
2. Standard allocations の free liquidity
3. withdrawal queue

buffer + reserve liquidity で足りれば single transaction で即時 withdraw できる。足りなければ per-reserve FIFO queue に入る。

Subly は API 決済の瞬間に Kamino withdraw を前提にしない。yield を定期的に realize し、Agent Wallet の USDC payment buffer に置いておく。

## Production Custody Model

### Bad For Production: Raw Agent Wallet Holds Principal Shares

Agent Wallet が Kamino shares を直接持ち、agent がその wallet を自由に署名できる場合:

- yield 分だけ withdraw できる。
- principal 分も withdraw できる。
- shares を別 wallet に transfer できる。

この状態では `principal_floor` は backend accounting rule であり、on-chain enforced invariant ではない。

### Recommended: Guard Controls Shares, Agent Controls Yield Buffer

```text
Kamino shares/kTokens:
  owned by Subly Guard PDA
  or delegated to Subly Guard PDA

USDC payment buffer:
  owned by Agent Wallet
  contains only realized yield
```

この分離が重要:

- 元本リスクは Guard 側に閉じる。
- x402/Solana payment は標準の SPL transfer として実行できる。
- Agent Wallet が侵害されても、失うのは realized yield buffer まで。

## Deposit Flows

### Flow A: Deposit Through Subly API

1. Agent/User requests `POST /subly402/deposit-intent`.
2. Subly builds Kamino deposit transaction for `Subly USDC Payment Vault Alpha`.
3. Agent Wallet signs deposit.
4. Kamino mints shares to Agent Wallet.
5. Subly immediately moves shares to Guard PDA, or asks user/agent for a second activation signature.
6. Guard records `principal_floor += actual_deposit_usdc`.
7. Future exchange-rate increase becomes payment budget.

Implementation note:

- If Kamino deposit API/SDK cannot mint directly to Guard PDA, use two transactions:
  1. deposit into Agent Wallet
  2. transfer shares to Guard PDA and update Guard principal
- This is acceptable for production if both are presented as one guided flow.

### Flow B: Deposit Through Kamino UI

1. User deposits into `Subly USDC Payment Vault Alpha` from Agent Wallet in Kamino UI.
2. Shares appear under the same wallet.
3. User/Agent opens Subly and runs `activate/sync`.
4. Subly reads current share balance and exchange rate.
5. Subly moves newly detected shares to Guard PDA, or sets Guard PDA as delegate.
6. Guard records principal floor for those shares.

Important:

- Same wallet deposit is enough to make the position discoverable.
- It is not enough to make the position principal-protected until activation/delegation.
- Subly should display `unprotected Kamino shares` vs `protected payment principal`.

## Delegate Support

別 wallet でも可能。SPL Token には delegate/approve があるため、share token account の spending authority を別 address に渡せる。

本番で安全な使い方:

```text
share token account delegate = Subly Guard PDA
```

危険な使い方:

```text
share token account delegate = Agent Wallet or Subly backend EOA
```

理由:

- SPL delegate は token amount の allowance を持つだけ。
- `yield-only` の制約は SPL Token が理解しない。
- yield-only を enforcement するのは Guard Program。

Kamino withdraw instruction が delegate authority を直接受け入れない場合でも、Guard は delegated transfer で shares を Guard PDA owned share ATA に移し、その後 Guard-owned shares として withdraw できる。この方が設計として安全。

## Yield Realization

Guard の budget formula:

```text
position_value = guard_shares * exchange_rate
gross_yield = max(0, position_value + realized_buffer - principal_floor)
spendable_yield =
  gross_yield
  - reserved_payments
  - fee_debt_usdc
  - safety_buffer
```

Realization flow:

1. Off-chain keeper reads Kamino Vault exchange rate and Guard position.
2. Keeper computes target buffer, e.g. next 24h expected API spend.
3. Keeper calls Guard `realize_yield(amount_usdc)`.
4. Guard verifies invariant after withdrawal.
5. Guard burns/moves only yield-equivalent shares through Kamino withdraw.
6. USDC lands in Agent Wallet payment buffer or Guard USDC ATA.
7. If withdrawal enters queue, amount is `pending` and not spendable until settled.

For x402-like UX, prefer:

```text
API payment uses already-realized USDC buffer.
Kamino withdraw is asynchronous/background.
```

If buffer is insufficient:

- return `402 budget_pending`
- or Subly temporarily advances payment from treasury and recovers from future yield
- or ask user to wait until yield is realized

The third option is safest. The treasury advance option improves UX but adds credit risk.

## Subly402 Payment Flow

Subly402 should behave like x402:

1. Agent requests paid API.
2. Server returns `402 Payment Required`.
3. Response contains:
   - `scheme`
   - `network`
   - `asset`
   - `amount`
   - `payTo`
   - `resource`
   - `expiresAt`
   - `paymentId`
4. Agent SDK asks Subly Facilitator to prepare payment.
5. Facilitator checks:
   - domain allowlist
   - merchant allowlist or risk score
   - max price per request
   - daily/monthly cap
   - realized yield buffer
   - duplicate `paymentId`
6. Agent Wallet signs standard SPL USDC transfer from yield buffer.
7. Subly sponsor wallet signs as fee payer.
8. Facilitator submits/settles transaction.
9. Agent retries original API request with `PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE`.
10. Server returns the resource.

For maximum compatibility with existing x402 on Solana:

- Use Solana CAIP-2 network `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`.
- Use USDC mint `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`.
- Use a standard SPL transfer payment transaction when possible.
- Keep principal protection outside the payment transaction by controlling what USDC reaches the Agent Wallet.

## Fee Payer

Subly should be fee payer.

Options:

1. Subly sponsor wallet signs as transaction fee payer.
2. Kora handles gasless transaction flow.

Fee accounting:

```text
fee_debt_usdc += estimated_sol_fee_usdc
spendable_yield -= fee_debt_usdc
```

The user should not need SOL for:

- deposit
- share activation
- yield realization
- API payment

Subly can pay SOL fees and recover from yield. If yield is too low, Subly either subsidizes maintenance operations or pauses paid API execution.

## Can This Work With Existing x402?

Partially yes.

Works well:

- Agent Wallet pays merchant using standard SPL USDC transfer.
- x402 server/facilitator can verify a normal Solana payment.
- Subly sponsor can be fee payer if the x402 SVM transaction format/facilitator allows separate fee payer, or Subly runs its own facilitator.

Needs Subly-specific extension:

- Checking Kamino yield budget.
- Enforcing principal protection.
- Keeping payment buffer funded.
- Recovering SOL fee costs from yield.
- Returning `budget_pending` when yield is not yet liquid.

Therefore the practical product is:

```text
Subly402 = x402-compatible where possible
         + Subly yield-budget extensions
         + Subly facilitator/paymaster
```

## Main Production Risks

1. **Kamino liquidity risk**: yield may exist economically but not be instantly withdrawable.
2. **Guard integration risk**: CPI into Kamino withdraw must be verified against actual KVault instruction constraints.
3. **Farm/staked share risk**: Kamino UI may place shares in a vault farm; activation must handle unstake/transfer/delegate correctly.
4. **Agent buffer risk**: if Agent Wallet holds realized yield, compromised agent can spend that buffer. Limit buffer size.
5. **Fee sponsor risk**: Subly pays SOL first; it must rate-limit and recover cost from yield.
6. **x402 duplicate settlement**: Solana payments need duplicate settlement cache; x402 docs explicitly call this out.
7. **Economic risk**: low APY or small principal means very small payment budget.

## Feasibility Rating

- **Deposit to Kamino through API**: feasible.
- **Detect same-wallet Kamino UI deposit**: feasible.
- **Turn Kamino yield into USDC**: feasible, but liquidity/queue-aware.
- **x402-like API payment from yield**: feasible.
- **Subly as fee payer**: feasible.
- **User pays no SOL**: feasible with sponsor/Kora.
- **Principal cannot be touched by agent**: feasible only if shares are controlled by Guard, not by raw agent wallet.
- **Fully standard x402 with no Subly extension**: not enough, because x402 does not understand Kamino principal/yield accounting.

## Sources

- Kamino vault model: https://kamino.com/docs/curators/vaults/concepts/how-vaults-work
- Kamino liquidity and withdrawal queue: https://kamino.com/docs/curators/vaults/concepts/liquidity-and-withdrawals
- x402 client/server flow: https://docs.x402.org/core-concepts/client-server
- x402 facilitator: https://docs.x402.org/core-concepts/facilitator
- x402 networks and Solana USDC support: https://docs.x402.org/core-concepts/network-and-token-support
- Solana spend permissions / delegate: https://solana.com/docs/payments/advanced-payments/spend-permissions
- Solana fee abstraction: https://solana.com/docs/payments/send-payments/payment-processing/fee-abstraction
