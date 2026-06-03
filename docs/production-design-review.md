# Subly Production Design Review

最終更新: 2026-05-28 JST

## 結論

Subly の yield-funded payment は本番でも技術的に実現可能。ただし、本番で「元本を使えない」と言うためには、agent wallet のソフトウェアルールでは不十分で、Vault share/kToken に対する権限を on-chain guard で制限する必要がある。

本番の推奨アーキテクチャ:

```text
User wallet
  -> Kamino UI or Subly UI deposit
  -> receives Kamino Vault shares
  -> approves/transfers shares to Subly Guard Program

Subly Guard Program
  -> stores principal floor
  -> owns or is delegated over Vault shares
  -> only allows yield portion to be withdrawn
  -> pays merchant from realized yield USDC

Subly/Kora fee payer
  -> pays SOL fees
  -> recovers fee cost from yield budget in USDC
```

## Why Agent-Owned Wallet Is Not Enough

「agent-owned wallet が Kamino shares を持つ」設計では、同じ秘密鍵/署名権限で以下が全部できる。

- yield 分だけ withdraw
- 元本分も含めて全部 withdraw
- share token を別 wallet に transfer
- USDC buffer を全部 transfer

`principal_floor` は Subly backend の会計ルールであり、Solana/Kamino のプログラムが強制している制約ではない。したがって、バグ、侵害、悪意ある agent、誤設定があれば元本を動かせる。

本番で必要なのは「agent が元本を使わないように約束する」ことではなく、「agent が元本を使う権限を持たない」こと。

## Production Principal Guard

Subly Guard Program を作る。Guard は wallet ごとの principal floor を保存し、Kamino Vault share のうち yield 相当分だけを USDC に realize できる。

Guard の最小 state:

```text
subly_position
  owner
  vault
  share_mint
  principal_floor_usdc_raw
  realized_yield_usdc_raw
  reserved_usdc_raw
  fee_debt_usdc_raw
  bump
```

Guard の重要 invariant:

```text
post_position_value + realized_yield_usdc - reserved_usdc
  >= principal_floor_usdc + safety_buffer_usdc
```

この invariant を満たさない `withdraw_yield` / `pay` instruction は失敗させる。

## Two Viable Custody Models

### Model A: Guard Custody

ユーザが Kamino Vault shares を Guard PDA の token account に deposit する。

利点:

- 一番わかりやすい。
- Guard が shares を完全に管理できる。
- 元本保護 invariant を強制しやすい。

欠点:

- ユーザの wallet から share が出るので、Kamino UI 上の表示とユーザ体験を設計する必要がある。

### Model B: Guard As Token Delegate

ユーザの wallet に shares を置いたまま、share token account の delegate を Guard PDA にする。

利点:

- ユーザの wallet に Kamino shares が残る。
- ユーザは delegate を revoke できる。
- Kamino UI から deposit した後、Subly activate transaction で delegate 設定できる。

欠点:

- SPL Token delegate は「最大 amount」しか制限できない。yield-only 条件は Token Program ではなく Guard Program が enforcing する。
- delegate が EOA/agent wallet だと危険。delegate は Guard PDA にする。
- Kamino withdraw が delegate authority を直接受け付けない場合、Guard はまず delegated transfer で shares を Guard PDA に移してから withdraw する必要がある。
- token account は active delegate を 1 つしか持てない。

本番では Model B か Model A を使う。agent wallet への直接 delegate は、allowance 分を agent が自由に使えるため、production の principal protection にはしない。

## Different Wallet Support

別 wallet でも可能。ただし本番では次のどちらかにする。

1. User wallet が share token account の delegate を Subly Guard PDA に設定する。
2. User wallet が shares を Subly Guard PDA に deposit する。

ユーザが agent wallet / backend wallet に直接 delegate する設計は、限定 allowance の範囲内で元本を使えてしまうため、yield-only protocol としては弱い。

## Kamino Withdrawal Queue

Kamino Vault の withdrawal は常に即時とは限らない。公式 docs では、withdrawal は次の順で処理される。

1. unallocated buffer
2. Standard allocations のうち reserve に free liquidity がある分
3. 残りは per-reserve FIFO withdrawal queue

buffer + reserve liquidity で全額足りれば single transaction で即時 withdraw できる。足りない部分は withdrawal ticket として queue に入り、borrower repayment/new deposits/liquidations などで reserve に liquidity が戻ると FIFO で埋まる。

本番の payment では、API request 時に Kamino withdraw を待たない。Guard/relayer は事前に yield を USDC buffer に realize しておき、x402/API 決済はその buffer から払う。

推奨運用:

- Payment Vault は unallocated buffer を持つ。
- fixed-rate/high-utilization reserve への過剰配分を避ける。
- API 決済用に Guard 側 USDC buffer を持つ。
- queue に入った pending withdraw は settlement まで spendable に含めない。

## SOL Fee Handling

Solana transaction は SOL fee payer が必要。本番ではユーザ/agent に SOL を要求せず、Subly paymaster が fee payer になる。

選択肢:

1. Subly の sponsor wallet を fee payer にする。
2. Kora を使って fee abstraction / gasless transaction を提供する。

どちらの場合も、実際の SOL は sponsor が支払う。Subly は fee cost を USDC 換算し、yield budget から `fee_debt_usdc_raw` として回収する。

fee policy:

```text
spendable_yield =
  position_value
  + realized_yield_usdc
  - principal_floor_usdc
  - reserved_payment_usdc
  - fee_debt_usdc
  - safety_buffer_usdc
```

yield が足りない場合は、API payment だけでなく yield realization や sponsored transaction も policy で止める。ただし必要な maintenance transaction は Subly が運用費として subsidize してもよい。

## Kamino UI Deposit Handling

同じ wallet で Kamino UI deposit すれば、その wallet の share balance は増える。問題は「share があるか」ではなく「どこまでが principal で、どこからが yield か」を本番で安全に確定すること。

本番で安全な flow:

1. User deposits to Subly Vault on Kamino UI.
2. User opens Subly and activates the position.
3. Subly reads current share balance and exchange rate.
4. User signs an activation transaction:
   - Guard custody model: transfer shares to Guard PDA.
   - Guard delegate model: approve Guard PDA as delegate.
5. Guard stores current position value as principal floor, unless deposit tx history is fully parsed.

これなら複雑な historical indexer に依存しない。後から追加 deposit した場合も、user signs `sync_deposit` and Guard increases principal floor by the new deposit value.

Pure indexer-only design は、share transfer-in/out、external withdraw、farm stake/unstake、failed/partial tx を完全に分類する必要があるため、本番の principal protection の根拠にしない。

## "Effectively Free" Wording

技術的には「principal は使わず yield だけで支払う」は正しい。ただし yield はユーザの収益であり、DeFi/liquidity/USDC risk と opportunity cost がある。

投資家・規制・セキュリティレビュー向けには:

- Use now, pay from yield
- Principal-preserving payments
- No principal drawdown under Guard invariant

を使う。マーケティング headline として "effectively free" を使う場合も、脚注で "paid from generated yield, not from principal" と明確にする。

## Required Production Changes To `technical-design.md`

- Replace agent-owned wallet as default with Subly Guard Program.
- Treat agent-owned wallet only as demo or trusted-custody mode.
- Add Guard custody/delegate activation after Kamino UI deposits.
- Add fee payer / Kora / fee debt accounting.
- Define queue-aware yield realization and USDC payment buffer as mandatory.
- Avoid saying x402 payment can always realize yield synchronously from Kamino.

## Sources

- Kamino vault model: https://kamino.com/docs/curators/vaults/concepts/how-vaults-work
- Kamino liquidity and withdrawal queue: https://kamino.com/docs/curators/vaults/concepts/liquidity-and-withdrawals
- Solana spend permissions / token delegation: https://solana.com/docs/payments/advanced-payments/spend-permissions
- Solana approve delegate: https://solana.com/docs/tokens/basics/approve-delegate
- Solana fee abstraction: https://solana.com/docs/payments/send-payments/payment-processing/fee-abstraction
- Kora: https://launch.solana.com/docs/kora
