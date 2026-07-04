# Subly Spending Mandate Design — 委任署名・閾値承認・Kill Switch

作成: 2026-07-04 JST / Status: **Phase 1 実装済み** (server core、2026-07-04。
実装ノートは末尾「Implementation Notes — Phase 1」参照)。Phase 2 (web
setup/approve ページ + passkey) は未実装。

> 背景: 「AI エージェントが資金を動かすには human-in-the-loop が必要」という
> 規制要件に対し、業界 (AP2 / Coinbase Agentic Wallets / Visa Intelligent
> Commerce / Mastercard Agent Pay) は「取引ごとの人間承認」ではなく
> 「**委任時の人間承認 (署名済みポリシー) + 範囲のインフラ強制 + 閾値超過時のみ
> 取引時承認 + 監査証跡と即時取消**」に収束している。本設計はこの 4 点を
> Subly の既存アーキテクチャ (relayer が authoritative な yield-only guard)
> の上に追加する。

## Goal

1. **Spending Mandate**: 人間 (owner) が ed25519 署名した支出委任文書を
   relayer に登録し、全支払いをその範囲内に強制する。「誰がいつ何を承認したか」
   を第三者検証可能にする (AP2 Intent Mandate 相当)。
2. **Server-enforced caps**: per-payment / daily / monthly の支出上限を
   relayer 側で強制する。現在クライアント側にしかない per-payment cap
   (`defaultMaxAmountRawUsdc`) を、改造不能な境界に移す。
3. **Threshold escalation**: mandate の `approvalThresholdRawUsdc` を超える
   支払いは、owner 署名による取引時承認 (HITL) がなければ realize を拒否する。
4. **Kill switch + audit**: owner はいつでも mandate を即時 revoke でき、
   人間可読な spending log で全支払いを追跡できる (mandate → realize tx
   までは relayer 自身の記録、realize → x402 payment はクライアントの
   report-back + on-chain 検証によるベストエフォート連結)。

既存の yield-only guard (`purpose: "yield_realize"` の spendable-yield 強制)
は「元本に触れない」という構造的上限としてそのまま残り、mandate はその上に
重なる。regulatory ナラティブは「**数学的上限 (yield-only) × 委任署名 ×
閾値 HITL × kill switch**」の 4 層になる。

## Non-goals

- On-chain での mandate 強制 (program / PDA custody)。強制点は relayer。
  technical-design.md の Non-goals と同じ理由で、relayer attestation を
  claim とする。
- 汎用の multi-owner / role ベース権限。owner は単一鍵。
- 通知チャネル (email / Slack / push) の実装。Phase 3 で approval の
  伝達手段として追加するが、本設計では承認の**検証**だけを規定する
  (チャネル非依存: relayer は owner 署名のみを信頼する)。

## Core Decisions

- **強制点は relayer の `prepareWithdrawal(purpose: "yield_realize")`**。
  全ての x402 支払いが必ず通る唯一の budget gate であり、既存の
  yield-only guard と同じ場所。クライアント (改造可能) は precheck のみ。
- **Owner credential と agent key は別物を推奨、同一鍵 (self mode) も
  許容**。self mode とは `ownerAuth: "ed25519"` かつ owner 公開鍵 =
  agentWallet の構成を指す (専用フィールドは持たず導出する)。delegated
  (別 credential) では agent key が漏洩してもポリシーを自分で緩められ
  ない — これが委任の意味。self はポリシー強制と監査は効くが委任証明と
  しては弱い、と文書上も区別する。
- **Realize 要求に payment binding を追加**。現在 realize は金額しか
  持たないが、`{ payTo, amountRawUsdc, resourceUrlHash, method }` を
  必須にし、cap の単位を「支払い」にし、監査ログを「何に払ったか」まで
  引ける形にする。
- **カウンタは持たず ledger から rolling window 集計** (UTC 基準 24h / 30d)。
  realize 確定 = 支出として計上する (realize 済みで x402 側が失敗した
  ケースも保守的にカウント)。
- **Approval は owner credential の署名文書で、single-use / binding-bound /
  TTL 付き**。agent は owner credential を持たないため承認を偽造できない。
  承認の運搬は「agent がチャットに approve リンクを貼る → 人間がスマホで
  開き passkey / wallet で署名」が主経路 (ターミナル常用者には CLI 代替)。
  チャットは承認依頼の配達だけを担い、認可の実体は運ばない。
- **Deposit (元本の DeFi 投入) は金額に関わらず owner 承認必須がデフォルト**
  (`depositPolicy: "owner_approval_required"`)。支払いは yield しか通らない
  が、deposit は元本を DeFi プロトコルリスクに晒す唯一の入口であり、
  低頻度・高額なので HITL の摩擦が最も割に合う場所。初回 deposit は
  setup の mandate 署名に同梱し、Face ID 1 回で mandate + 初回 deposit の
  両方を認可する (`initialDeposit`)。これにより規制ナラティブは「**元本は
  人間の生体認証なしに DeFi に入らない**」まで言い切れる。

## Policy Layering — Wallet 基盤側ポリシーとの重ね合わせ

Agent wallet は生の local keypair とは限らない。`AgentWalletSigner` の
抽象が既に想定している通り、Privy / Turnkey / Coinbase CDP (Agentic
Wallets) / MPC custody / Squads 型 smart account など、**独自の policy
engine を持つ wallet 基盤**が署名境界になるケースがある。それらは
per-tx cap・session cap・payee allowlist・独自の承認フローを signer 側で
強制する。本設計はそれらと競合せず重ねる:

```text
Layer 1  Wallet 基盤 policy (signer 境界)
         「この鍵が何に署名するか」— agent ATA の全 USDC (Subly 外の
         残高含む) と x402 支払い tx 自体を守る。custody 側で強制。
Layer 2  Subly Mandate (relayer 境界) ← 本設計
         「vault yield から何を realize してよいか」— yield provenance、
         principal 保護、委任記録、realize→支払いの監査連鎖。
Layer 3  Yield-only guard (既存) — 数学的上限。
```

原則と設計上の帰結:

- **合成は intersection (最も厳しい方が勝つ)**。支払いは両層を通過して
  初めて成立する。deny が 2 層あることは defense in depth であり、
  片方を bypass しても他方が残る — 規制説明上はむしろ強い。優先順位の
  解決や委譲プロトコルは作らない (作ると片層の無効化手段になる)。
- **Subly mandate は wallet policy の代替にはならないし、逆も同じ**。
  wallet policy engine は vault ledger を見えないので「principal か
  yield か」を判定できない。逆に Subly relayer は agent ATA の
  Subly 外 USDC の流出を見えない。守る対象が違う。
- **運用モードは 2 つ、setup 時に人間が宣言する**:
  - `enforcementMode: "subly"` — 生 keypair のみの構成 (現行 beta の形)。
    Subly が cap / 閾値承認 / kill switch の全てを担い、mandate 未登録でも
    relayer デフォルトポリシー (下記) が適用される。
  - `enforcementMode: "wallet_infra"` — policy engine を持つ wallet 基盤
    (Privy / Turnkey / CDP / Squads 等) が signer の構成。cap と閾値承認は
    wallet 基盤側に委譲し (`dailyApiSpendCapRawUsdc` 等を null)、Subly は
    yield provenance + 委任記録 + 監査 + `perPaymentCapRawUsdc` (vault 側の
    最終 backstop) だけを担う。宣言は human の self-declaration であり
    relayer からは検証できない — ゆえに backstop はこのモードでも外さない。
- **二重 HITL の UX 衝突**: wallet 基盤も閾値承認を持つ場合、1 支払いに
  承認が 2 回要求されうる。推奨は「escalation はどちらか一層に寄せる」
  — wallet 基盤に承認フローがあるなら mandate の
  `approvalThresholdRawUsdc: null` とし、Subly は cap 強制と監査に徹する。
  逆に生 keypair 運用では Subly が唯一の escalation 層になる。
  この選択は `mandate init` の対話で確認する。
- **Owner の正体のマッピング**: mandate v1 の owner は ed25519 鍵なので、
  Phantom 等の人間用 wallet の message signing でそのまま署名できる
  (owner key = 人間の普段の wallet、が最も自然な delegated 構成)。
  custody 基盤側の管理者 identity (OIDC / API key) を owner とみなす
  attestation 型の mandate は将来拡張とし、v1 では扱わない。
- **署名側 policy hook**: signer 境界の `IntentValidationPolicy` は
  wallet 基盤実装が独自チェックを挟む既存の口であり、本設計は変更しない。

## Mandate Document

JSON の canonical 化は key-sorted JSON (`JSON.stringify` with sorted
keys, no whitespace) とし、実装を `src/lib/canonical-json.ts` に置く。
署名対象 message は wallet-auth (`src/api/wallet-auth.ts`) と同じ流儀:

```text
署名対象 message (utf8 1 行):
  subly-mandate:v1:{sha256hex(canonicalJson(payload))}
```

`ownerSignature` の検証は `ownerAuth` により 2 経路:

- `"ed25519"`: 上記 message への detached 署名 (wallet-auth と同一の検証)。
- `"passkey"`: WebAuthn assertion。relayer が発行する challenge に上記
  message の sha256 を埋め、assertion (authenticatorData +
  clientDataJSON + signature) を丸ごと保存・検証する。WebAuthn の署名
  対象は `authenticatorData || sha256(clientDataJSON)` であって message
  そのものではないため、検証器は challenge の一致・origin (rpId =
  app.subly.fi)・counter を併せて確認する。

```json
{
  "version": 1,
  "ownerAuth": "passkey",
  "ownerCredential": {
    "credentialId": "<base64url WebAuthn credential id>",
    "publicKey": "<base64url COSE public key>"
  },
  "enforcementMode": "subly",
  "agentWallet": "<base58 agent wallet pubkey>",
  "vault": "5kfkpQZ6AkQgizHVThqkxD4J3db2i7pE3mHdPNRbx7jr",
  "issuedAtMs": 1751600000000,
  "expiresAtMs": 1783136000000,
  "policy": {
    "perPaymentCapRawUsdc": "10000000",
    "dailyApiSpendCapRawUsdc": "100000000",
    "monthlyApiSpendCapRawUsdc": null,
    "dailyDepositCapRawUsdc": "3000000000",
    "approvalThresholdRawUsdc": "1000000",
    "allowedPayToAddresses": null,
    "depositPolicy": "owner_approval_required",
    "withdrawalPolicy": "owner_approval_required"
  },
  "initialDeposit": { "amountRawUsdc": "500000000" }
}
```

`ownerAuth: "ed25519"` の場合、`ownerCredential` は
`{ "publicKey": "<base58 pubkey>" }`。self mode = `ownerAuth: "ed25519"`
かつ publicKey = agentWallet (導出であり専用フィールドは無い)。
`enforcementMode` ("subly" | "wallet_infra") は Policy Layering 節の
運用モード宣言をここに記録する。

ポリシー軸はユーザ向けには 2 つの言葉で説明する:
「**1 日の有料 API 利用料**」(`dailyApiSpendCapRawUsdc` — yield_realize
確定合計の rolling 24h 上限) と「**DeFi に deposit できる量**」
(`dailyDepositCapRawUsdc` — vault deposit 確定合計の rolling 24h 上限)。
per-payment cap と approval threshold はその内側の安全装置。

デフォルトポリシー (mandate 未登録時に relayer が適用、かつ
`mandate init` の初期値):

| 軸 | デフォルト | raw |
| --- | --- | --- |
| `approvalThresholdRawUsdc` | 1 USDC — これ以下は自動 | `"1000000"` |
| `perPaymentCapRawUsdc` | 10 USDC — 承認があっても超えられない絶対上限 | `"10000000"` |
| `dailyApiSpendCapRawUsdc` | 100 USDC / 日 | `"100000000"` |
| `dailyDepositCapRawUsdc` | 3,000 USDC / 日 | `"3000000000"` |

**3 段の意味論** (threshold < per-payment cap が不変条件、登録時に検証):

```text
amount <= threshold            : 自動 (人間に聞かない)
threshold < amount <= cap      : owner 承認があれば実行
cap < amount                   : 承認があっても拒否 (絶対上限)
```

承認を経た支払いも daily / monthly cap には算入する (承認は threshold
の免除であり cap の免除ではない)。業界の参照点: Coinbase / AWS の x402
設計例が「session $100 + $10 超は人間承認」。x402 の実支払いは
0.001〜0.05 USDC 級なので threshold 1 USDC は通常運用でほぼ発火しない。
なお yield-funded の性質上、daily API cap が実際に効く前に spendable
yield が先に尽きる (100 USDC/日の yield には TVL ~50 万 USDC 規模が
必要) — daily cap は通常運用では発火しない純粋な backstop である。

**Deposit はこの 3 段に乗らない**: `depositPolicy:
"owner_approval_required"` (デフォルト) では金額に関わらず全 deposit が
owner 承認 (Face ID) 必須で、`dailyDepositCapRawUsdc` は承認があっても
超えられない絶対上限として残る (承認は threshold の免除と同様、cap の
免除ではない)。支払いと違い deposit は低頻度 (初回 + まれな追加) なので
閾値による自動帯を設けない。`"agent_allowed"` に緩めると cap 内で自動に
なる (パワーユーザ向けオプトアウト)。

- 金額は全て raw USDC (6 decimals) の string。`null` の cap は「無制限」
  ではなく「その軸のチェックなし (wallet_infra モードでの委譲)」を明示する
  (perPaymentCap は必須)。
- 文書は 2 署名を持つ: `ownerSignature` (owner key、委任の引き受け) と
  `agentWalletSignature` (agent wallet key による mandate hash への署名、
  資金の現権限者が owner 指名に同意した証明)。初回登録は両方を検証し、
  置換・revoke は現 owner 署名のみで足りる (詳細は「Owner の確立と署名の
  実行場所」)。
- `approvalThresholdRawUsdc: null` は「エスカレーションなし (cap 内は全て
  自動)」。`"0"` は「全支払い承認必須」で、フル HITL モードとして機能する。
  非 null の場合、登録時に `threshold < perPaymentCap` を検証する
  (`invalid_policy_thresholds`)。
- `allowedPayToAddresses`: 任意の payee allowlist (null = 制限なし)。
- `depositPolicy`: `"owner_approval_required" (デフォルト) |
  "agent_allowed"`。deposit (元本の DeFi 投入) を owner 承認必須にする。
- `withdrawalPolicy`: `"agent_allowed" | "owner_approval_required"`。
  normal withdraw (元本 exit) を owner 承認必須にできる。現状 agent が
  無制限に withdraw できることは「元本は守られる」ナラティブの穴であり、
  `delegated` モードではこれを塞げる。
- `initialDeposit` (任意、payload トップレベル): setup で合意した初回
  deposit 金額。mandate の owner 署名 + agent co-sign がそのままこの
  1 件の deposit 承認を兼ねる (AP2 の Intent Mandate が意図した購入を
  含むのと同型)。relayer は mandate active 化と同時に binding
  `{ kind: "deposit", amountRawUsdc }` の**承認済み・single-use・TTL 15
  分の approval を発行**し、approvalId を setup 完了レスポンスと
  `GET mandate` で返す — 人間の Face ID は 1 回で済む。replace で
  mandate を再登録する際の `initialDeposit` は無視する (初回専用)。
- 再登録 (replace) は `issuedAtMs` が現行より大きいことを要求 (rollback
  replay 防止)。revoke は即時・恒久で、同 owner の新 mandate 登録での
  復帰のみ許す。
- **失効 (expiresAtMs 経過) 後は mandate 未登録扱い = relayer デフォルト
  ポリシーに戻る**。`withdrawalPolicy` の保護も切れるため、失効が近い
  mandate は spending log と MCP 応答に警告を載せ、更新 (replace) を促す。
- **Owner 喪失時のリカバリ (dead-man switch)**: passkey を platform
  アカウントごと失った場合に元本がデッドロックしないよう、**agent
  wallet key 署名による時限 revoke** を用意する:
  `POST /v1/wallets/:wallet/mandate/recovery-revoke` (agent wallet-auth)
  で revoke を予約 → **72 時間の猶予**の間は現 owner が署名 1 つで拒否
  できる (pending 状態は spending log / MCP / 通知チャネルに露出) →
  猶予経過で mandate 失効・デフォルトポリシーに復帰。エージェント単独
  では即時にはポリシーを外せず、owner が生きていれば必ず気づいて
  止められる、という業界のアカウントリカバリと同型の妥協点。

## Approval Document

閾値超過時に relayer が作る pending approval に対し、owner が decision を
署名して返す。

```text
署名対象 message (utf8 1 行):
  subly-approval:v1:{approvalId}:{approve|deny}:{bindingHash}:{signedAtMs}
```

- `bindingHash = sha256hex(canonicalJson(binding))`。承認は特定の操作
  内容に不可分に紐づく。binding は 3 種:
  `{ kind: "payment", payTo, amountRawUsdc, resourceUrlHash, method }` /
  `{ kind: "deposit", amountRawUsdc }` /
  `{ kind: "withdrawal", amountRawUsdc }`。文書形式・TTL・single-use の
  規則は全種共通。
- TTL: `requestedAtMs + 15 min` で自動 expire。
- Single-use: prepare が成功した時点で `consumed`。同じ approvalId の
  再利用は拒否。
- `signedAtMs` は decision 時刻の freshness (wallet-auth と同じ 5 min 窓)。

## Enforcement Flow

`VaultFlowService.prepareWithdrawal` の `purpose: "yield_realize"` 分岐に、
既存 guard の**前段**として追加。入力拡張:

```jsonc
// POST /v1/withdrawals/prepare (wallet-auth, agent 署名)
{
  "wallet": "...",
  "amountRawUsdc": "58000",
  "purpose": "yield_realize",
  "payment": {                     // yield_realize では必須
    "payTo": "<base58 seller ATA owner>",
    "amountRawUsdc": "58000",
    "resourceUrlHash": "<sha256hex(url)>",
    "method": "POST"
  },
  "approvalId": "apr_..."          // 閾値超過の再試行時のみ
}
```

チェック順序と error code (既存 `error.code` 形式)。mandate 未登録時は
1 を「デフォルトポリシー適用」に読み替える:

1. mandate が active で未失効か → `mandate_revoked` / `mandate_expired`
   (未登録・失効はデフォルトポリシーで続行)
2. `allowedPayToAddresses` (設定時) → `payee_not_allowed`
3. `payment.amountRawUsdc <= perPaymentCapRawUsdc` (絶対上限、承認でも
   超えられない) → `per_payment_cap_exceeded`
4. rolling 24h / 30d の realize 確定合計 + 今回額が daily / monthly cap 内
   → `daily_cap_exceeded` / `monthly_cap_exceeded` (承認済み支払いも算入)
5. `threshold < 額 <= cap` なら、`approvalId` が (a) 存在し (b) `approved`
   で (c) bindingHash 一致 (d) 未 expire (e) 未 consume であること →
   満たさなければ **pending approval を新規作成して** `approval_required`
   を返す (下記)。デフォルトポリシー適用中 (owner 未登録) は承認を検証
   できないため `mandate_required_for_larger_payments` で拒否し setup を
   案内する
6. 既存 yield-only guard (spendable yield / instant liquidity /
   post-state principal invariant) — 変更なし

approval の consume は **prepare 成功時ではなく、その approval で認可
された realize withdrawal が `confirmed` に達した時点**とする
(`consumed_by_withdrawal_id` に紐づけ)。prepare 後に submit / confirm が
失敗した場合、TTL 内なら同じ approvalId で再 prepare できる (in-flight
は同時 1 本のみ) — 一時的なチェーン障害のたびに人間へ再承認を求めない
ための措置で、binding 拘束 + TTL + 単一 in-flight で replay は防がれる。

`approval_required` レスポンス (HTTP 403 ではなく 409 系。何も realize
していないので安全に再試行できる):

```json
{
  "success": false,
  "error": {
    "code": "approval_required",
    "message": "この支払いは承認閾値 0.05 USDC を超えています。owner の承認後、同じ呼び出しを approvalId 付きで再試行してください。",
    "approvalId": "apr_9f3c...",
    "expiresAtMs": 1751601000000,
    "approveUrl": "https://app.subly.fi/approve/apr_9f3c...",
    "approveCommand": "subly-pay approve apr_9f3c..."
  }
}
```

エージェントは `approveUrl` をそのままチャットに貼る (主経路)。
`approveCommand` はターミナル常用者向けの代替表記。

Deposit 側: `prepareDeposit` に 2 段のチェックを入れる。

1. rolling 24h の deposit 確定合計 + 今回額が `dailyDepositCapRawUsdc`
   以内 → 超過は `daily_deposit_cap_exceeded` で拒否 (承認があっても
   超えられない絶対上限)。
2. `depositPolicy: "owner_approval_required"` (デフォルト) なら、有効な
   `approvalId` (binding `{ kind: "deposit", amountRawUsdc }`、支払いと
   同じ single-use / TTL / bindingHash 検証) が無ければ **pending
   approval を作成して `deposit_approval_required`** (409、approveUrl
   付き — 支払いの `approval_required` と同形) を返す。approval の
   consume は deposit confirmed 時 (支払い側と同じ)。初回 deposit は
   mandate の `initialDeposit` が発行する approval で通る。

deposit の cap は元本そのものではなく DeFi プロトコルリスクへの
exposure 増加速度を抑える。承認必須の非対称性は意図的である: deposit は
リスクに**入る**操作なので人間の同意を要し、withdraw (agent 自身の ATA
への exit) はリスクから**出る**操作なのでデフォルトでは agent に任せる
(`withdrawalPolicy` で締めることは可能)。

mandate 未登録の wallet: **relayer デフォルトポリシーを適用する**
(Coinbase 型の infra default — 未設定でも野放しにならない)。デフォルトは
cap のみで承認パスを持たない: owner key が未登録なので approval を検証
できず、閾値超・cap 超は `mandate_required_for_larger_payments` で拒否し、
setup リンク (owner 登録) を案内する。**deposit も同様に owner 不在では
承認しようがないため `mandate_required_for_deposit` で拒否する** — 実質、
owner 登録 (setup) が deposit の前提になり、「元本は owner の承認なしに
DeFi に入らない」が未登録 wallet にも貫かれる (初回 deposit は setup の
`initialDeposit` 同梱で摩擦なく通る)。signed mandate の登録でデフォルトを
置換できる。spending log には `policySource: "default" | "mandate:<hash>"`
を記録する。既存 beta wallet への移行は relayer デプロイ時に
`SUBLY_MANDATE_ENFORCEMENT=off|warn|on` の env 段階導入とする
(warn: 違反をログのみ)。

## API Surface

全て既存 Fastify server (`src/api/server.ts`) に追加。owner 署名の検証は
wallet-auth の transport 署名 (誰が送ったか) とは独立に、**文書内署名**
(誰が承認したか、永続監査用) を検証する。

```text
PUT  /v1/wallets/:wallet/mandate      mandate 文書 (owner 署名入り) を登録/置換
GET  /v1/wallets/:wallet/mandate      現行 mandate と mandateHash (wallet or admin)
POST /v1/wallets/:wallet/mandate/revoke
                                      owner 署名の revoke 文書。即時失効 = kill switch
POST /v1/wallets/:wallet/mandate/recovery-revoke
                                      agent wallet-auth。owner 喪失時の時限 revoke 予約
                                      (72h 猶予後に発効)
POST /v1/wallets/:wallet/mandate/recovery-cancel
                                      owner 署名。pending の recovery-revoke を拒否
GET  /v1/wallets/:wallet/approvals?status=pending
                                      pending approval 一覧 (wallet or admin)
POST /v1/approvals/:approvalId/decision
                                      owner 署名の approve/deny 文書
GET  /v1/wallets/:wallet/spending-log
                                      人間可読の支払い履歴 (下記)
POST /v1/payments/report              agent wallet-auth。x402 支払い完了後に
                                      支払い tx signature を report-back する
                                      (realize の payment binding に紐づけ)
POST /v1/wallets/:wallet/setup-sessions
                                      agent wallet-auth。合意ポリシー + 初回 deposit 額を
                                      prefill した setup セッションを作成し setup URL を
                                      返す (TTL 10 分、単回)
GET  /v1/setup-sessions/:sessionId    setup ページが表示する内容 (公開、単回 URL)
POST /v1/setup-sessions/:sessionId/complete
                                      owner credential 作成 + 署名済み mandate を提出。
                                      initialDeposit があれば承認済み approvalId を返す
POST /v1/webauthn/challenge           passkey 署名用 challenge の発行 (approve / setup)
```

- `PUT mandate` / `POST revoke` / `POST decision` の認可は**文書内の
  owner credential 署名**で行う (ed25519 message 署名、または WebAuthn
  assertion — challenge に文書 hash を埋める)。transport は web ページ /
  CLI どちらからでもよい。self mode (owner publicKey = agentWallet) の
  場合は agent key がそのまま owner 署名を行う。
- revoke 文書: `subly-mandate-revoke:v1:{mandateHash}:{signedAtMs}`。
- spending-log entry は 1 支払い 1 行で:
  `{ paidAtMs, payTo, amountRawUsdc, resourceUrlHash, method,
     realizeTxSignature, paymentTxSignature | null,
     paymentVerification: "verified_onchain" | "reported" | "unreported",
     decision: "auto_within_policy" | "owner_approved:apr_...",
     mandateHash }`
  — AP2 の intent→cart→payment チェーンに相当する「委任 → 個別判断 →
  実行 tx」の対応表を relayer ledger から出す。
- **監査連鎖の正直な限界**: mandate → realize tx までは relayer 自身の
  記録だが、x402 支払い tx はクライアント側 (@x402/svm) で行われ relayer
  は直接見ていない。payment binding は「支払う意図の申告」である。
  クライアントは支払い成功後に `POST /v1/payments/report` で tx
  signature を report-back し、relayer は on-chain の TransferChecked
  (payTo / amount) をベストエフォート検証して `paymentVerification` に
  記録する。report が無い realize は `unreported` として監査上区別する。

## Data Model (Postgres)

```sql
CREATE TABLE spending_mandates (
  wallet            TEXT PRIMARY KEY,
  mandate_json      JSONB NOT NULL,        -- 署名込みの原文書
  mandate_hash      TEXT NOT NULL,         -- sha256hex(canonicalJson(payload))
  owner_auth        TEXT NOT NULL,         -- passkey | ed25519
  owner_credential  JSONB NOT NULL,        -- credentialId+COSE 公開鍵 or base58 pubkey
  enforcement_mode  TEXT NOT NULL,         -- subly | wallet_infra
  issued_at_ms      BIGINT NOT NULL,
  expires_at_ms     BIGINT NOT NULL,
  status            TEXT NOT NULL,         -- active | revoked | recovery_pending
  recovery_at_ms    BIGINT,                -- dead-man switch の発効予定時刻
  revoked_at_ms     BIGINT,
  revoke_json       JSONB                  -- 署名済み revoke / recovery 文書
);

CREATE TABLE spending_mandate_events (     -- 全登録/置換/revoke の追記型履歴
  id              BIGSERIAL PRIMARY KEY,
  wallet          TEXT NOT NULL,
  event_type      TEXT NOT NULL,           -- registered | replaced | revoked
  mandate_hash    TEXT NOT NULL,
  document_json   JSONB NOT NULL,
  created_at_ms   BIGINT NOT NULL
);

CREATE TABLE payment_approvals (           -- payment / deposit / withdrawal 共通
  approval_id     TEXT PRIMARY KEY,        -- apr_ + random
  wallet          TEXT NOT NULL,
  binding_hash    TEXT NOT NULL,
  binding_json    JSONB NOT NULL,          -- kind: payment | deposit | withdrawal
  mandate_hash    TEXT NOT NULL,
  status          TEXT NOT NULL,           -- pending | approved | denied | expired | consumed
  decision_json   JSONB,                   -- 署名済み decision 文書。initialDeposit 由来は
                                           -- { source: "mandate_initial_deposit", mandateHash }
  requested_at_ms BIGINT NOT NULL,
  decided_at_ms   BIGINT,
  consumed_at_ms  BIGINT,
  consumed_by_withdrawal_id TEXT           -- confirmed で consume した realize
);
```

支出集計は `withdrawal_intents` (purpose = yield_realize, status =
confirmed) への rolling window クエリで行い、intent 行に
`payment_binding JSONB`、`mandate_hash`、`payment_tx_signature` (report-
back)、`payment_verification` を追加する。deposit 側の集計は同様に
`deposit_intents` (status = confirmed) への rolling window クエリ。
index: 両テーブルに `(wallet, confirmed_at_ms)`。

## Client / MCP Changes

- `YieldRealizer.ensureUsdcAvailable` の入力に payment binding を追加
  (`standard-x402-payer.ts` は 402 challenge から payTo / amount / url を
  既に持っているので、そのまま渡すだけ)。
- 支払い成功後 (x402Fetch が 200 を返した後)、payer は
  `POST /v1/payments/report` で支払い tx signature をベストエフォートで
  report-back する (失敗しても支払い結果には影響させない)。
- `StandardX402PayError` に reason `"approval_required"` を追加。realize
  前の拒否なので**何も支払われていない**ことを message で明示し、
  `approvalId` / `approveUrl` / `expiresAtMs` を detail に載せる。
- MCP `fetch_with_subly_payment`: `approval_required` は isError では
  なく構造化レスポンスで返し、tool description に「`approveUrl` を
  そのままユーザに提示し、ユーザが承認を終えたと言ったら同じ呼び出しを
  approvalId 付きで再試行する」ことを明記する。approvalId は tool 入力に
  追加する。
- `packages/pay` CLI (**ターミナル常用者向けの代替経路**。owner が人間の
  端末で実行、パスフレーズ暗号化された owner 鍵を読む。平文 keypair は
  拒否):

```text
subly-pay mandate init      対話式にポリシーを決めて署名・登録
subly-pay mandate show      現行 mandate と使用状況 (daily/monthly 残枠)
subly-pay mandate revoke    kill switch
subly-pay approve <id>      pending approval の内容を表示 → y/N → 署名送信
subly-pay log               spending log の人間可読表示
```

`mandate init` は agentWalletSignature (co-sign) を要するため agent
keypair と owner 鍵が同一マシンにある場合のみ成立する (Claude Code 型)。
VPS 分離構成では web setup を使う。

- `deposit_to_subly_vault` (MCP) は `deposit_approval_required` /
  `mandate_required_for_deposit` を isError ではなく構造化レスポンスで
  返し、approveUrl (または setup リンク) をユーザに提示 → 承認後に
  approvalId 付きで再試行する — `fetch_with_subly_payment` の
  `approval_required` UX と同一パターン。approvalId を tool 入力に追加。
  初回 deposit はセットアップ完了時に返る approvalId で人間の追加操作
  なしに通る。
- `withdraw_from_subly_vault` (MCP) は `withdrawalPolicy:
  "owner_approval_required"` のとき同じ escalation に乗る (approval の
  binding は `{ kind: "withdrawal", amountRawUsdc }`)。

### Setup Timing — チャットで合意し、人間のスマホで認可する

Subly の主要ハーネスには「人間の手元にターミナルが無い」形態が含まれる
(OpenClaw: agent は常駐プロセスとして VPS 等で動き、人間は Telegram /
WhatsApp で会話するだけ)。したがって**認可行為はターミナルではなく
人間のスマホ / ブラウザで完結させる**。「会話の中で合意し、認可だけ
エージェントの届かない場所で行う」という構造は Circle CLI と同一で、
認可の器具がターミナル + email OTP ではなく**チャットに貼られたリンク +
passkey / wallet 署名**になる。

**Owner 指名のタイミングはオンボーディング (最初の deposit を作る会話)
の 1 ステップ**である — このときエージェントに Subly を設定させている
人間が必ずチャットの向こうに居るから。流れ:

1. エージェントがチャットでデフォルトポリシー (承認閾値 1 / 絶対上限
   10 / daily API 100 / daily deposit 3,000 USDC) と**初回 deposit 額**を
   提示し、変更の要否を会話で合意する。
2. エージェントが relayer に setup session を作成し (agent wallet-auth、
   合意した値 + 初回 deposit 額を prefill)、返ってきた **setup リンクを
   そのままチャットに貼る**: `https://app.subly.fi/setup/st_...`
   (TTL 10 分、単回)。
3. 人間がスマホでリンクを開く。ページは agent wallet アドレスと提案
   ポリシー、初回 deposit 額を**表示するのみ (confirm-only、ページ上で
   値は変更できない)**。
   値を変えたい場合はチャットに戻って合意し直し、エージェントが新しい
   session を発行する — mandate は agent wallet の co-sign (mandate hash
   への署名) を含むため、ページ側で値が変わると agent 署名が無効になる。
   confirm-only は「承認画面で金額をいじれない」という決済 UI の原則とも
   一致する。人間は内容を確認して **owner credential を作成し署名する**。
   credential は次のいずれか:
   - **passkey (デフォルト)**: WebAuthn。Face ID / 指紋でその場で作成・
     署名。wallet アプリ不要 — Visa / Mastercard が agent 決済の認可に
     使うのと同じ器具で、最も消費者向き。
   - **Solana wallet (パワーユーザ向け)**: Phantom 等の message sign。
     ed25519 owner として mandate v1 の形式そのまま。
4. relayer が mandate を active 化し、`initialDeposit` の承認済み
   approvalId を発行する。エージェントは読み取り専用 API で確認して
   チャットに要約し、その approvalId で初回 deposit を実行する —
   **Face ID は 1 回で mandate と初回 deposit の両方が済む**。
   スキップされた場合、支払い側は relayer デフォルトポリシーが効き
   続けるが、**deposit は owner 不在では承認できないため実行できない**
   (`mandate_required_for_deposit`) — Subly を実際に使い始めるには
   setup が事実上必須になる。以後の追加 deposit は都度 approve リンク
   → Face ID (支払いの閾値承認と同じ器具)。

**閾値超過の承認も同じ器具**で行う: エージェントが承認リンク
`https://app.subly.fi/approve/apr_...` をチャットに貼る → 人間がスマホで
開き、支払い内容 (宛先 / 金額 / URL) を確認して passkey / wallet で署名
→ エージェントが approvalId 付きで再試行する。kill switch (revoke) も
同じ管理ページに置き、同じ credential で認可する。ターミナルを常用する
人間 (Claude Code 等) 向けには `subly-pay` CLI を**代替経路**として残す
(owner 鍵はパスフレーズ暗号化必須) が、主経路はあくまで web である。

**メールは不要**。Circle の email + OTP は「identity がメール」という
Circle 側の前提の帰結であり、OTP 自体が目的ではない。Subly の identity
は最初から鍵 (wallet-auth: the wallet key itself is the identity) なので、
認可の証明は owner key 署名がそのまま担う — 使い捨て OTP より強い
(暗号学的・否認不能・第三者が事後検証可能)。メール/Slack 等が意味を
持つのは認可の証明ではなく**通知の到達** (human-not-present 時に閾値
超過を知らせる) のみで、Phase 3 の任意設定 webhook とし、仕様上の必須
要素にはしない。人間がチャットに居る通常ケースでは、エージェントの
承認依頼の発話が通知そのものになる。

### Owner 鍵の隔離 — 「人間しか署名できない」を仕組みで保証する

署名は 2 種類あり、自動化の扱いが正反対であることを明確にする:

- **agent key**: ポリシー内の支払いはエージェントが会話中に**自動署名
  する (人間に聞かない)**。これが製品の本体であり、統制は事前ポリシーと
  relayer 強制が担う (Coinbase の enclave 自動署名と同じ)。deposit も
  tx への署名自体は agent key の自動署名だが、relayer が owner 承認
  (approvalId) なしには prepare を返さないため、人間の Face ID が
  常に先行する。
- **owner key**: mandate 登録/変更/revoke と approval。自動署名された
  瞬間に「人間の承認」が消えるため、**エージェントが実行できない**こと
  を運用ルールではなく構造で保証しなければならない。

脅威: エージェントはシェルを持つ (OpenClaw / Claude Code の Bash)。
owner 鍵が同じマシンに**平文ファイル**で在れば、エージェントは
`subly-pay approve` を自力で完走できてしまい、「人間の端末で実行して
ください」は技術的強制のないお願いに落ちる。Circle の email OTP が
解いているのは正にこれ — 認可の最後の要素が機械の外 (人間の受信箱)
にしか無い。

対策 (メール不要のまま同じ構造を作る):

1. **別デバイス credential (主経路)**: owner credential は人間のスマホ /
   ブラウザにしか存在しない passkey、または人間の wallet (Phantom 等)
   の鍵とし、setup / approve / revoke は web ページで行う。owner の
   秘密がエージェントのマシンに**そもそも存在しない**ため、シェルを
   持つエージェントにも承認を完走できない (Squads / Crossmint
   dual-key と同型)。
2. **CLI + パスフレーズ暗号化 owner 鍵 (ターミナル常用者向けの代替)**:
   `subly-pay` 経由で運用する場合、owner 鍵は暗号化保存を必須とし、
   署名時に TTY 対話でパスフレーズを要求する (平文 keypair は CLI が
   拒否、stdin が TTY でない場合も拒否)。パスフレーズは人間の頭の中に
   しか存在しない = OTP 相当。エージェントのシェル経由で打たないことを
   README / CLI の警告文で明示する。
3. **self mode (owner = agent key) はこの保証を持たない**ことを明示する。
   relayer 強制 (cap / yield-only) と監査は効くが、「人間が承認した」
   ことの暗号学的証明はできない。beta の単一鍵運用の互換モードであり、
   規制文脈の主張は「delegated モード + 暗号化 owner 鍵」以上を前提と
   する。

補助層として、ハーネスのツール実行確認 (Claude Code / OpenClaw の
permission prompt) やコマンド allowlist も効くが、ユーザーが
auto-approve を有効にし得るため、本設計はそれを当てにしない。

### Owner の確立と署名の実行場所

**何を持って owner とするか / いつ指名されるか**: owner は
**オンボーディング (最初の deposit を作る会話) の setup リンクで、
人間がスマホ上で credential を作成した瞬間に確立する**。mandate 文書は
2 つの署名を持つ — 指名された owner credential による `ownerSignature`
(委任の引き受け) と、agent wallet key による `agentWalletSignature`
(資金の現権限者がこの owner 指名に同意した証明、署名対象は mandate
hash)。初回登録はこのペアで成立し、以後の置換・revoke・approval は
**現 owner の署名のみ**が権限を持つ。

owner credential は `ownerAuth` として mandate に記録する:
`"passkey"` (WebAuthn credential、assertion を ownerSignature として
検証) または `"ed25519"` (Solana wallet / keypair の message 署名)。
どちらも on-chain には一切現れない (off-chain 署名専用) — 資金も SOL も
不要な、純粋な認可用 identity である。**owner は「wallet」である必要
すらない** (passkey なら wallet アプリ非保有の人間でも成立)。agent
wallet と owner が別物であることはむしろ推奨構成。

信頼モデルの正直な注記 (残余リスク):

- bootstrap 時点で agent key を握る者が owner を指名できる。
  「セットアップの時点で既にエージェントが敵対的」というケースは構造上
  どの製品も防げない (Circle も「登録 email の持ち主 = 人間」を前提と
  する)。委任が意味を持つのは指名以後の分離である。
- **setup リンクは capability であり、最初に complete した者が owner に
  なる**。チャットチャネル自体が侵害されていればリンクを横取りされ得る。
  緩和は TTL 10 分 + complete の単回性 + ページに agent wallet と
  ポリシーを明示 (人間が自分の設定内容と照合できる) + 完了をチャットに
  要約報告 (覚えのない完了に気づける)。なお「単回」は complete に適用
  し、GET (ページの再読込) は complete 前なら何度でも許す。

**署名がどこで実行されるか** — チャット UI の中では決して署名しない。
「署名する」とは常に「owner credential にアクセスできるプロセスが
署名 (ed25519 または WebAuthn assertion) を計算して relayer に HTTPS
POST する」ことであり、その実行場所は:

| 署名 | 実行場所 | 人間の操作 |
| --- | --- | --- |
| agent key (支払い / realize、承認取得済み deposit) | MCP / 常駐プロセス内で自動 | なし (ポリシー内なら聞かない。deposit は owner 承認が先行) |
| owner — web 経路 (主経路) | 人間のスマホ / ブラウザ | チャットに貼られたリンクを開き、内容確認 → Face ID (passkey) または wallet の message sign |
| owner — CLI 経路 (代替) | 人間のマシンの `subly-pay` プロセス | 自分のターミナルで `subly-pay approve <id>` → y/N → パスフレーズ |

どちらの経路も relayer への HTTPS POST に帰着し、approval API は経路
共通 — relayer は「登録済み owner credential の有効な署名か」だけを
検証する。**owner credential が agent の動くマシンに存在する必要は
一切ない** (存在しないことが望ましい)。

**ハーネス別の実際の体験**:

- OpenClaw (agent は VPS の常駐プロセス、人間は Telegram / WhatsApp):
  承認要求が発生したら、エージェントがチャットに approve リンクを貼る。
  人間はスマホでタップ → 支払い内容確認 → Face ID → 完了。ターミナルは
  一切登場しない。setup (owner 指名) も同じ形でオンボーディング会話中に
  済んでいる。
- Claude Code (人間の手元のターミナルで動く): 同じ approve リンクを
  開いてもよいし、ターミナル常用者は代替の `subly-pay approve <id>` を
  別ターミナルで使ってもよい。チャット内 (`!` prefix 含む) では実行
  しない — パスフレーズがエージェント文脈を通ってしまう (CLI 側でも
  stdin が TTY でない場合は拒否する)。

web ページの規模感: 静的 1 枚 + relayer API (approval / setup 内容の
取得、decision の POST、WebAuthn challenge 発行) で足り、「Web サイト
構築」というほどの投資にはならない。ただし passkey 検証 (WebAuthn
assertion) が relayer 側に増えるぶん、純 ed25519 のみの構成より実装は
増える。

passkey は PC でも同じリンクで機能する: Mac は Touch ID、Windows は
Windows Hello (顔 / 指紋 / PIN)。QR コード経由でスマホの Face ID に
委譲する WebAuthn cross-device は、生体センサーの無い PC だけでなく
**エコシステム混在** (Android スマホで作った passkey を Mac で使う等、
platform アカウントを跨いで同期されないケース) でもブラウザが自動で
発動する。同一エコシステム内 (iPhone + Mac 等) では passkey が Apple /
Google アカウントで端末間同期されるため、スマホで作った owner
credential を後日 PC のブラウザからそのまま使える (1Password 等の
パスワードマネージャー保存ならエコシステム横断でも同期される)。承認に
使うデバイスは毎回自由 — relayer は「登録済み credential の有効な
assertion か」だけを見る。厳密には owner は「1 デバイス」ではなく
「その人の platform アカウント」に紐づく — synced passkey は業界標準の
トレードオフであり、「エージェントのマシンに存在しない」という核心は
変わらない。credential の交換 (機種変・エコシステム移行) は現 owner
署名による mandate replace で行う。

参考: Circle スキルが提示する保守的推奨値は per-tx 1 / daily 5 /
weekly 20 / monthly 50 USDC と Subly デフォルトよりかなり低いが、
Circle の cap は wallet 残高 (元本) 全体の流出を守るのに対し、Subly の
daily API cap は yield しか通らない経路の backstop であり、リスクの
母数が異なる。元本移動に相当する deposit / withdraw 側は
`depositPolicy` (承認必須) + `dailyDepositCapRawUsdc` と
`withdrawalPolicy` が担う。

## Security Notes

- **Agent key 漏洩時**: 攻撃者は cap 内・allowlist 内でしか支払えず、
  ポリシー変更・approve・revoke はできない (`delegated` モード)。owner は
  revoke で即停止できる。これが本設計の中心的な主張。deposit 承認必須に
  より、漏洩鍵で ATA の USDC を勝手に vault へ積み増すこともできない
  (ATA 残高そのものの流出を守るのは Layer 1 = wallet 基盤 policy の領分)。
- **Relayer 改竄検知**: 全 prepare レスポンスと spending log に
  `mandateHash` をエコーし、owner は手元の署名済み文書と照合できる。
  relayer はポリシーを勝手に緩めても署名を偽造できない。
- **Approval replay**: single-use + bindingHash 拘束 + TTL。同一内容の
  再購入は新しい approval が必要。
- **Realized-but-unpaid**: realize 確定後に x402 側が失敗しても cap には
  計上済み (vault から出た事実を数える)。`external_outcome_unknown` の
  既存リカバリと整合。
- **時刻**: window 集計・TTL は relayer 時計基準。mandate の
  `issuedAtMs` 単調増加要求で古い mandate の再登録を防ぐ。
- **Recovery-revoke の悪用**: agent key 漏洩者は recovery-revoke で 72
  時間後にポリシーを default へ戻せるが、pending 状態が spending log /
  MCP / 通知に露出するため、owner は猶予中に拒否 + 資金退避できる。
  即時性を犠牲にした意図的なトレードオフ (owner 喪失デッドロックの
  回避が優先)。
- **Approval consume**: confirmed 時 consume + TTL 内再 prepare 許可は、
  binding 拘束・単一 in-flight・TTL の 3 点で二重支払いを防いだ上で、
  チェーン障害時に人間へ再承認を求めないための措置。

## Phasing

- **Phase 1 — Server core (デフォルトポリシー + cap 強制 + log)**:
  canonical-json / mandate 検証、schema、prepareWithdrawal /
  prepareDeposit guard、relayer デフォルトポリシー、spending-log、
  mandate API。`SUBLY_MANDATE_ENFORCEMENT=warn` で先行デプロイ → `on`。
  規制対応の核 (未設定でも上限がある + 監査) がここで完成する。
- **Phase 2 — チャット native な owner 体験 (主経路)**: setup / approve /
  revoke の web ページ (passkey + wallet 署名)、setup-session API
  (initialDeposit 同梱)、approval テーブル + decision API、payer / MCP の
  `approval_required` / `deposit_approval_required` UX + approvalId
  再試行。**`depositPolicy` の強制もここで on にする** (承認の器具である
  web ページが前提のため。Phase 1 の間は daily deposit cap のみ)。
  OpenClaw (Telegram 等、ターミナル無し形態) の全フロー — owner 指名 +
  初回 deposit から閾値承認・kill switch まで — がここで成立する。
- **Phase 3 — 到達性と拡張**: payTo allowlist、withdrawal
  owner-approval、approval 通知チャネル (webhook)、`subly-pay` CLI の
  mandate / approve 経路 (ターミナル常用者向け代替)。

## Validation Plan

- Unit: canonical JSON の安定性、mandate/approval/revoke の署名検証
  (ed25519 + WebAuthn assertion)、rolling window 境界 (ちょうど cap /
  cap+1、24h 境界)、**threshold / cap の 3 段境界 (threshold ちょうど /
  +1 / cap ちょうど / +1、threshold >= cap の登録拒否)**、approval state
  machine (pending→approved→confirmed で consume、submit 失敗後の TTL 内
  再 prepare、expire、binding 不一致)、**deposit approval (approvalId
  なし prepare の拒否、initialDeposit approval の発行・single-use・
  replace 時の無視、daily deposit cap は承認でも超えられない)**、
  setup session の単回性/TTL、
  **recovery-revoke の状態遷移 (予約 → owner 拒否 / 猶予経過)**、
  payments/report の on-chain 検証。
- Integration: prepareWithdrawal / prepareDeposit の拒否マトリクス
  (error code × enforcement mode off/warn/on)、mandate 置換の
  issuedAtMs 単調性。
- E2E (mainnet demo): Telegram 相当のチャットからオンボーディング →
  setup リンクを passkey で完了 (Face ID 1 回で mandate + 初回 deposit)
  → 閾値超の Nansen 購入 → `approval_required` → スマホで approve
  リンクを開き passkey 承認 → 再試行で支払い成功 → 追加 deposit が
  `deposit_approval_required` → approve → 成功 → spending log に
  `owner_approved` で記録、revoke 後は全支払い・deposit 拒否。

## Implementation Notes — Phase 1 (2026-07-04 実装)

実装済み (server core): `src/lib/canonical-json.ts` / 文書検証
`src/domain/spending-mandate.ts` / 強制と approval state machine
`src/domain/spending-mandate-service.ts` / `VaultFlowService` への guard 統合 /
mandate・approvals・spending-log・payments/report API / Postgres schema
(`spending_mandates`, `spending_mandate_events`, `payment_approvals`) /
`SUBLY_MANDATE_ENFORCEMENT=off|warn|on` (デフォルト warn) /
クライアントの payment binding pass-through (`standard-x402-payer` →
`relayer-yield-realizer` → `vault-flows`)。テスト:
`tests/spending-mandate*.test.ts`, `tests/mandate-api.test.ts`,
`tests/vault-flow-service.test.ts` (integration 節)。

設計からの差分・精密化:

- **approval テーブル + decision API を Phase 1 に前倒し** (ed25519 owner
  のみ)。web ページと passkey (WebAuthn) 検証は Phase 2 のまま —
  `ownerAuth: "passkey"` の mandate は `owner_auth_unsupported` で拒否する
  (検証せず受理する穴を作らないため)。
- **agentWalletSignature の署名対象**は owner と同じ 1 行 message
  `subly-mandate:v1:{mandateHash}` (「mandate hash への署名」のバイト列を
  正確化)。
- **owner credential 交換 (rotation) は `currentOwnerSignature` フィールド**
  (現 owner による新 mandate message への署名) を replace 文書に載せる。
  現 owner と同一 credential の replace には不要。revoke 済み wallet の
  復帰は同一 owner credential の文書のみ受理。expired / recovery 経過は
  未登録相当として扱う (issuedAtMs 単調性は常に強制)。
- **recovery-cancel の署名 message** を
  `subly-mandate-recovery-cancel:v1:{mandateHash}:{signedAtMs}` と規定。
- intent 上の記録フィールド名は `policyDecision`
  (`auto_within_policy` | `owner_approved:apr_...` | `warned:<code>` |
  `unenforced`)、`policySource` (`default` | `mandate:<hash>`)。level=off で
  prepare した realize は `unenforced` と記録し監査上区別する。warn モードで
  違反があった realize は最初の違反コードを `warned:<code>` として記録し、
  spending log 上でも「ポリシー的にはクリーンでなかった」ことが残る。
- **Kill switch は warn モードでも強制する**: `mandate_revoked` は
  warn / on の両方で realize・deposit を block する (off のみ全無効)。
  revoke は mandate 登録済み wallet への明示的 owner 操作としてしか
  存在し得ないため、binding 未対応の旧クライアントを壊すことはない。
- mandate の expiresAtMs は recovery_pending 中も適用される (expired が
  優先)。expired mandate への recovery-revoke / recovery-cancel は
  `mandate_expired` で拒否 (expired = 未登録相当なので再登録が正)。
- `POST /v1/payments/report` は `{ wallet, withdrawalId,
  paymentTxSignature }` を取り、binding の payTo ATA への TransferChecked
  相当の残高 delta ≥ amount を best-effort 検証して
  `verified_onchain | reported` を記録する。report は 1 realize = 1 tx:
  異なる signature での上書きは `payment_already_reported` で拒否、同一
  signature の再 report は冪等 (検証は reported → verified_onchain への
  昇格のみ、降格しない)。
- approval の遅延 expiry の永続化は状態遷移パス (decision / prepare 時の
  参照) のみで行い、GET (listApprovals) は読み取り専用の導出ビューを返す。
  approval decision は prepare と同じ wallet-vault lock 内で処理する。
- 窓集計は Phase 1 では position 単位の intent 一覧を ledger から読み
  メモリで合計する (既存フローの読み方と同型)。行数が問題になったら
  設計どおり SQL rolling window + index に移す。
- warn モードでは pending approval を作らない (block しないため)。
  binding 無しの旧クライアントも warn ログのみで通す — `on` へ上げるのは
  クライアント (MCP / pay CLI) が binding を送るようになってから。

## Implementation Notes — Phase 2 (2026-07-04 実装)

実装済み (チャット native な owner 体験): setup-session API
(`POST /v1/wallets/:wallet/setup-sessions` は agent wallet-auth、
`GET /v1/setup-sessions/:id` と `POST .../complete` は公開 capability URL) /
owner web ページ 3 枚を relayer 自身が配信 (`/setup/:sessionId`,
`/approve/:approvalId`, `/revoke/:wallet` — 外部アセットなしの自己完結
HTML、passkey がデフォルトで Phantom message sign が代替) / passkey
(WebAuthn) 検証 (`src/domain/webauthn-owner.ts`) / depositPolicy 強制
(`deposit_approval_required` / `mandate_required_for_deposit`) / payer・MCP
の `approval_required` 系 UX + approvalId 再試行 / `POST /v1/payments/report`
のクライアント呼び出し (X-PAYMENT-RESPONSE 由来、best-effort)。
テスト: `tests/setup-session.test.ts`, `tests/mandate-api.test.ts`
(setup-session API 節), `tests/spending-mandate*.test.ts` (passkey /
deposit 節), `tests/standard-x402-payer.test.ts`, `tests/vault-flows.test.ts`。

設計からの差分・精密化:

- **passkey 検証は自前実装で依存追加なし**。ownerCredential は COSE 鍵
  ではなく `AuthenticatorAttestationResponse.getPublicKey()` の SPKI DER
  (base64url) + `algorithm` (COSE alg id: -7 ES256 / -8 EdDSA / -257 RS256)。
  attestation は検証しない (attestation "none" 前提。信頼アンカーは
  ed25519 経路と同じ「登録済み credential による assertion」であり、
  デバイス出自証明は要件でない)。assertion の署名対象は WebAuthn 標準の
  `authenticatorData || sha256(clientDataJSON)`、challenge は
  `base64url(sha256(署名対象 message))` で文書に暗号学的に拘束される。
  clientData の type/origin、authenticatorData の rpIdHash と UP+UV flag を
  検証する。署名 counter は追跡しない (synced passkey では 0 固定が普通で、
  クローン検知はこの信頼モデルの範囲外)。passkey の owner 署名はすべて
  `base64url(JSON {credentialId, authenticatorData, clientDataJSON,
  signature})` として既存の signature フィールドに載る (schema 上限 8KB)。
- **setup-session の agent co-sign 代替**: ownerCredential はページ上で
  作られるため agent は事前に mandate hash へ署名できない。session 作成
  (policy / initialDeposit / TTL を body に含む) が agent wallet-auth 署名
  で行われることを co-sign の代替とし、complete は session prefill との
  完全一致 (`setup_session_mismatch`) を強制する (ページが選べるのは
  issuedAtMs と ownerCredential のみ)。document 上の
  `agentWalletSignature` は setup-session 経路でのみ省略可。session の
  wallet-auth ヘッダは監査 provenance として mandate event に記録する。
- **web ページは relayer が配信**する (app.subly.fi は不要)。rpId /
  origin は `SUBLY_WEBAUTHN_RP_ID` / `SUBLY_WEBAUTHN_ORIGINS` で明示指定、
  未指定なら `SUBLY_SETUP_URL_BASE` / `SUBLY_APPROVE_URL_BASE` の URL から
  導出。**passkey は rpId に紐づくため、本番ではページを配信するドメイン
  (例 api.demo.sublyfi.com) に URL base を合わせること**。
- 承認ページ用の公開 read: `GET /v1/approvals/:approvalId` (capability =
  URL 自体) と `GET /v1/wallets/:wallet/mandate/summary` (revoke ページ用、
  mandateHash / status / ownerAuth / credentialId のみでポリシー内容は
  出さない)。
- deposit 承認は payment 承認と同一の state machine / TTL / single-use /
  in-flight 規則 (`requireOperationApproval` に一般化)。DepositIntent にも
  policySource / mandateHash / policyDecision / approvalId を刻印し、
  consume は deposit confirmed 時。enforcement level の意味は Phase 1 と
  同一 (on で強制、warn は `warned:<code>` 刻印のみ、kill switch は warn
  でも block)。
- クライアント: `VaultFlowClient.deposit` は approvalId 未指定で
  `deposit_approval_required` を受けたとき、approved 済み deposit approval
  (同額 binding — initialDeposit がこの形) を自動解決して 1 回だけ再試行
  する。「Face ID 1 回で mandate + 初回 deposit」がエージェント側の追加
  操作なしに成立する。MCP は `create_subly_setup_link` /
  `check_subly_setup` ツールを追加し、`approval_required` /
  `deposit_approval_required` / `mandate_required_for_deposit` は isError
  ではなく構造化レスポンス (approveUrl / approvalId / 再試行手順) で返す。
- payments/report のクライアント実装: 標準 x402 の settle レスポンス
  ヘッダ `X-PAYMENT-RESPONSE` (base64 JSON) から payment tx signature を
  読み、realizer 経由で best-effort report-back する (失敗は支払い結果に
  影響させない)。

### セルフレビュー修正 (2026-07-04、Phase 2 実装直後)

- **withdrawalPolicy の強制を実装** (本文どおり binding
  `{ kind: "withdrawal", amountRawUsdc }` で deposit と同一 escalation)。
  通常 withdraw の prepare は `authorizeWithdrawal` を通り、default は
  agent_allowed のまま、mandate が `owner_approval_required` を opt-in
  したときのみ `withdrawal_approval_required` (409 + approveUrl)。
  **kill switch (revoked) は withdraw も block する** — owner が agent 鍵を
  信用しなくなった後に元本を agent ATA へ引き出せると revoke が無意味に
  なるため。同 owner の再登録で解除できる。revoke ページの文言も
  payments / deposits / withdrawals に更新。
- **owner ページの表示ハードニング**: 動的値は全て `esc()` で HTML
  エスケープ (`binding.method` は agent 由来のため必須)、CSP meta
  (`default-src 'none'; script-src/style-src 'unsafe-inline';
  connect-src 'self'`) を全ページに付与、`paymentBindingSchema.method` は
  英字のみ (`^[A-Za-z]{1,16}$`) に制限。
- **setup ページは署名対象 policy の全項目を表示** (monthly cap /
  allowedPayToAddresses / withdrawalPolicy を追加、null cap は
  "No limit" と明示)。
- **既存 mandate がある wallet の setup link**: pending view に
  `existingMandate {status, ownerAuth}` を含め、ページは Face ID の前に
  「新 passkey では置換不可 (rotation は現 owner のみ)」を説明して
  passkey ボタンを無効化する (owner が passkey の場合は両ボタン非表示)。
  server 側の拒否 (`owner_rotation_requires_current_owner`) は従来どおり。
- ページ内 inline JS の crypto ヘルパー (canonicalJson / WebAuthn
  challenge / base58 / esc) は tests/owner-pages.test.ts が実行して
  サーバ実装とのバイト一致を検証する (base58 の空入力挙動を bs58 に一致
  させる修正込み)。
- MCP の setup 系ツールは chain sync (RPC) を走らせない (check_subly_setup
  はポーリングされるため)。relayer のエラーメッセージは英語に統一。
