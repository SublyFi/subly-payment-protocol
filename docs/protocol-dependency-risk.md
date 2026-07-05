# Subly Protocol Dependency Risk — Kamino exploit 時の対応設計

作成: 2026-07-04 JST / Status: **設計完了 (v2、全フェーズ詰め切り済み・実装未着手)**。
レビュー履歴は末尾「Review Log」参照。

> 背景: 「利回り源を Kamino に依存しているため、Kamino が exploit された
> 場合にユーザーが資金を失う。この場合どうするのかが検討できている必要が
> ある」という指摘への回答。2026-07-04 に業界事例を調査した結果、
> **リスクをゼロにする手段は存在しない**が、業界には確立された対応
> パターンがあり、それは「①事業が死なない構造 ②ユーザー損失の限定
> ③正直な開示と事前に文書化された事後対応」の 3 層に整理できる。
> 本設計はこの 3 層を Subly の既存アーキテクチャ (yield-only guard /
> spending mandate / kill switch) の上に追加する。

## 前提となる事実 — これは仮定の話ではない

2026-04-01、Solana 最大級の perp DEX である **Drift が実際に exploit
された** (約 $285M、Lazarus Group 帰属)。攻撃は偽担保トークンと Security
Council への social engineering による事前署名 tx で、**攻撃 6 日前に
timelock (24-72h 遅延) が撤去されていた**ことが決定打となり 12 分で
流出した。下流の 20+ プロトコルに波及し、その明暗が本設計の教科書になる:

| プロジェクト | Drift への露出 | 結果 |
|---|---|---|
| **Pyra** (利回りで決済を賄う payments アプリ) | 全面依存 | 出金全停止 → 回復不能と判断、2026-06 廃業 |
| **Carrot** (利回りアグリゲーター) | TVL の 50% | TVL 93% 崩壊 → 2026-04-30 清算。ユーザー約 50% 損失、回収分は IOU token |
| **Piggybank** | $106k のみ | チーム treasury から全額自腹補償、信頼維持・存続 |
| **Lulo / TradeNeutral 等** | 限定的 | 一時停止 → 安全確認後に再開・存続 |

**Pyra は Subly と同カテゴリ (yield-funded payments) であり、依存先の
exploit で商品ごと死んだ直接の前例**。生き残ったのは「露出に上限があった」
「自己資本で補償できる規模だった」プロジェクトだけである。

その他の参照事例:

- **Euler (Ethereum, 2023, $197M)**: 下流 11 プロトコルが被弾。Idle は
  即座に関連 vault を全停止、Balancer は emergency subDAO がプール停止、
  **Yearn は間接露出 $1.38M を「treasury が補償する」と即日宣言**。
  攻撃者が $240M を返還する稀有な結末だったが、各プロジェクトの初動
  (即 pause + 露出額の即時開示 + 補償方針の即日表明) が評価の分水嶺だった。
- **Loopscale (Solana, 2025, $5.8M)**: 即 pause → 10% white-hat bounty の
  オンチェーン交渉で**全額回収、ユーザー損失ゼロ**。
- **Drift 本体の回復**: 被害 $1 = 1 枚の recovery token を発行し、
  Tether $127.5M + パートナー $20M + プロトコル収益で回復プールを積立。
  なお Drift には Insurance Fund があったが「清算破綻用であり **外部
  exploit は対象外**」と明言された — 保険基金の存在が exploit カバーを
  意味しない点は Subly の説明でも誤認を招かないよう注意する。

## Kamino 依存の現状評価

Kamino は現時点で exploit 実績なし。防御態勢は Solana DeFi で最高水準:
外部監査 10 回以上 + Certora 形式検証 (精度損失バグを事前修正)、Immunefi
で Solana 最大の $1.5M bug bounty、公開リスクダッシュボード (KRAF,
risk.kamino.finance)、withdrawal caps (exploit 時のドレイン減速)、
Gauntlet による vault キュレーション。

ただし **Kamino に exploit 損失をユーザーへ補償する保険基金はない**。
発生すれば損失は預金者 (= Subly ユーザーの元本) 負担であり、Subly は
これを肩代わりする資本を現時点で持たない。この事実は隠さず開示する
(業界標準: Lulo も docs で「統合先のスマートコントラクトリスクが存在
する」と明記している。「全額安全」を謳うプロジェクトは存在しない)。

## 脅威モデルとスコープ

本設計が対象とするシナリオと、各シナリオに応答する層:

| # | シナリオ | 検知 (Phase 1) | 応答 |
|---|---|---|---|
| S1 | Kamino vault / klend の exploit による資金流出 | exchange rate 下落・流動性急減 | 自動 halt → プレイブック → reserve 補償 |
| S2 | 下層 reserve の bad debt 顕在化・oracle 障害による評価損 | exchange rate 下落 | 同上 (exploit と区別せず保守的に halt) |
| S3 | klend / kvault program の悪意ある (または乗っ取られた) upgrade | programData の slot 変化 | 自動 halt → 正規 upgrade と確認できたら手動解除 |
| S4 | vault admin / curator 権限の悪用 (authority 変更・penalty 引き上げ) | vault config drift 検知 | 自動 halt → 確認後解除。allocation 改変は正常運用 (curator のリバランス) と区別できないため直接 trip せず、被害が出れば rate / 流動性シグナル (S1) で間接検知 |
| S5 | 流動性枯渇 (損失ではないが出金できない) | (halt しない) | 既存 `VaultLiquidityError` + プレイブックの広報のみ |

**スコープ外** (別の設計・別の対策が正):

- **USDC depeg**: 資産リスクであり Kamino 依存リスクではない。開示には
  含める (Phase 0) が、本設計の検知・補償の対象外。
- **relayer / sponsor 鍵の侵害、agent 鍵の侵害**: spending-mandate-design.md
  と運用 (鍵管理) が正。
- **Solana L1 の停止**: 資金は失われない。運用停止広報のみ。
- **RPC が虚偽データを返す攻撃**: relayer 全体が単一 RPC を信頼する
  現行の trust base と同一なので、本設計では追加対策しない。残存リスク
  として明示する (「残存リスク」参照)。

## Goal

1. **開示 (Disclosure)**: 「Kamino が exploit された場合、vault 内の
   元本は失われうる。Subly は non-custodial であり、損失の補償を保証
   しない」を docs / ToS / beta-guide に明記し、ユーザーが理解した上で
   deposit する構造にする (deposit の owner 承認 = リスク引受の同意)。
2. **損失の限定 (Containment)**: 依存先の異常を検知したら deposit と
   yield_realize を自動停止し、被害を「事故時点の vault 残高」までに
   限定する。支払いバッファ (agent wallet の USDC) と vault 元本を
   分離し、exploit 時も支払い残高は無傷に保つ。
3. **事業の継続性 (Survivability)**: 単一プロトコル全損でも Subly が
   Pyra にならないための構造 — 露出上限、venue 抽象化、performance fee
   からの safety reserve 積立 — を発動条件付きで規定する。
4. **事後対応の事前文書化 (Playbook)**: 「その時になって考える」を
   なくす。pause 基準、開示テンプレ、出金猶予、補償の優先順位を
   本ドキュメントで確定しておく。

## Non-goals

- exploit リスクの排除。不可能であり、可能と主張しない。
- 全損時の全額補償の約束。資本規模的に不可能であり、約束しない
  (Piggybank 型の自腹補償は「露出が小さいうちは可能」な現実解として
  Phase 2 の reserve 規模設計に反映する)。
- Kamino 自体の監査・検証。Kamino の一次防御 (監査/bounty/KRAF) は
  与件として扱い、Subly は「依存する側の防御」だけを設計する。
- 外部保険 (Nexus Mutual / Amulet) の組込み。Solana の保険市場は薄く、
  コスト対効果が現状見合わない。Phase 3 の再評価項目に留める。
- 検知の完全性。ポーリング型監視は poll 間隔より速い事象を事前に
  止められない (「残存リスク」参照)。

## Core Decisions

- **リスクの答え方は「3 層」で統一する**。ユーザー・規制・投資家への
  説明は常に: (1) 元本は non-custodial に Kamino に入り、そのリスクは
  開示済み・owner 承認済み (2) Subly は監視 + 自動停止 + kill switch で
  被害を事故時点までに限定する (3) performance fee から safety reserve
  を積み立て、部分補償と事業継続を担保する。
- **強制点は既存と同じく relayer**。監視による自動停止は
  `VaultFlowService` の各フローの **prepare と submit の両方**で enforce
  する (フローは 2 段階で expiry 120s のため、prepare 後に trip した
  ケースを submit 側で塞ぐ)。クライアント側は precheck のみ
  (spending mandate と同じ構図)。
- **停止は deposit-first、出金は決して止めない**。halt が塞ぐのは
  deposit (新規元本の投入 = リスク拡大) と yield_realize (レートが
  信頼できない状態での換金) のみ。通常 withdraw / withdraw all は
  halted 中も通す。ユーザーの脱出経路は異常時こそ最優先で機能させる。
  Pyra の「出金全停止」が最悪手だったことの裏返し。
  - 注: halted 中の withdraw は「信頼できないレートでの出金」を
    ユーザー判断で許すことを意味する。これは意図した設計である —
    exploit 進行中は「早く逃げた者が救われる」のが現実であり、relayer が
    レート精査を理由に出金を遅らせる方が害が大きい。API レスポンスに
    `vaultHealth: "halted"` を含めてクライアントに警告表示させる。
- **支払いバッファと元本の分離を明文化する**。x402 支払いは realize 済み
  USDC (agent wallet ATA) から行われ、vault が全損しても支払い残高は
  影響を受けない。halt 中もバッファ残高分の支払いは継続できる。
- **Safety reserve は performance fee の一部から積み立てる**。収益 =
  TVL × perf fee (15-20%) というモデルと整合し、「収益の一部を常に
  ユーザー保護に還元している」という説明が成立する。全損補償ではなく
  「小規模事故の全額補償 + 大規模事故の部分補償と回復分配の原資」と
  位置付ける (Yearn / Piggybank 型)。perf fee 徴収自体が未実装のため、
  β期間は treasury からの seed で代替する (Phase 2 参照)。
- **venue 分散は発動条件付きの段階制**。現 TVL 規模で複数 venue 統合は
  複雑性に見合わない。TVL ラダー (Phase 3) で発動条件を数値として固定し、
  それまでは `KaminoVaultAdapter` の adapter 境界を壊さないことだけを
  守る。
- **trip 時に「最後に健全だった状態」をスナップショットとして永続化する**。
  このスナップショット (slot + exchange rate) が、事故後の per-user
  損失確定 (Phase 0 プレイブック) と補償分配 (Phase 2) の基準点を兼ねる。
  検知・記録・補償が同じデータを参照することで算定争いを避ける。

## Phase 0 — 開示とプレイブック (実装不要、即時)

### 0.1 リスク開示 — 確定文言と掲載場所

以下の文言を正とする (英語版は web 掲載時にこの文言から翻訳する):

> **元本のリスクについて**
> お客様の USDC は Subly が預かるものではありません。お客様の agent
> wallet の権限のまま Kamino Finance の Lend vault に non-custodial に
> 預け入れられ、利回りを生みます。Kamino は
> Solana で最大級の監査実績 (外部監査 10 回以上・形式検証・最大 $1.5M の
> bug bounty) を持つプロトコルですが、**スマートコントラクトの exploit・
> oracle 障害・貸付先の bad debt などにより、預け入れた元本の一部または
> 全部が失われる可能性があります**。Kamino にはこの損失を補償する保険は
> なく、**Subly も損失の補償を保証しません** (Subly が積み立てる safety
> reserve からのベストエフォートの補償はありますが、保険ではありません)。
> Subly は vault の健全性を常時監視し、異常検知時には新規預け入れと
> 利回りの換金を自動停止しますが、**お客様の出金はいかなる状況でも
> 停止しません**。USDC 自体の価値変動 (depeg) リスクは本開示の対象外です。

掲載場所 (すべて同一文言、要約不可):

1. `docs/beta-guide.md` — 冒頭の注意事項セクション。
2. ToS / web の deposit 導線 — 公開時に必須。
3. **owner setup / deposit 承認画面** — mandate 文書に `disclosureHash`
   フィールドを追加し、setup 時の owner 署名の対象に含める (署名 UI に
   開示全文を表示)。以後の個別 deposit approval はその mandate の下で
   行われるため、開示への同意は mandate 署名で一度取得すれば足りるが、
   deposit 承認画面にも開示要旨へのリンクを常置する。これにより
   「開示を提示された上で承認した」ことが署名で証明できる。
4. `packages/pay/README.md` — Risk セクションとして追加。

### 0.2 インシデント対応プレイブック

役割: β期間の運用者は単独 (yuki)。以下「運用者」はその単独運用者を指し、
組織化後も手順は変えず担当だけ割り当てる。

**T+0 — 検知/覚知 (自動 or 手動)**
- Phase 1 実装後: monitor が自動 halt。実装前: 運用者が
  `SUBLY_VAULT_HEALTH_FORCE_HALT=1` を設定して再起動 (Phase 1 実装
  までの唯一の手動代替。数分かかることを許容する)。
- withdraw が生きていることを必ず確認する (halt は withdraw を含まない)。

**T+1h 以内 — 第一報**
- 送信先: β参加者へ直接連絡 (メール/DM) + X。テンプレ:
  > 【Subly】Kamino に異常の可能性を検知し、新規預け入れと利回り換金を
  > 停止しました (日時 UTC)。**出金は通常どおり可能です**。影響範囲は
  > 調査中で、確認でき次第続報します。現時点の Subly 経由の Kamino
  > 預け入れ総額は約 $X、影響しうるウォレットは N 件です。
- 定量 (総露出額・件数) を必ず入れる。「調査中です」だけの第一報は
  Euler 下流の失敗例で信頼を落とした。

**T+24h 以内 — 損失スナップショットの確定**
- 基準点は **trip snapshot** (Phase 1 が永続化する最後の健全 slot と
  exchange rate。Phase 1 実装前の手動 halt では、halt 直前の
  `loadContext()` 相当の値を運用者が記録する)。
- per-user 損失 = (snapshot 時点の保有 shares × snapshot exchange rate)
  − (現在保有 shares の換金可能価値 + snapshot 以降に当該 wallet が
  出金で実際に受領した額 + その後の回収分配)。snapshot 後に不利な
  レートで脱出したユーザーの実現損もこの式で自然に拾える。ledger の
  position 記録と on-chain の両方から算定し、差異があれば on-chain を
  正とする。
- 続報テンプレ:
  > 【Subly 続報】影響の確定値: 対象ウォレット N 件、損失見込み合計 $X
  > (per-user の内訳は個別に通知します)。Kamino 側の対応状況: (リンク)。
  > 出金は引き続き可能です。補償方針は7日以内に提示します。

**T+7d 以内 — 補償方針の表明**
- 優先順位 (この順で適用、変更しない):
  1. **safety reserve による按分補償** (Phase 2)。reserve 残高 ≥ 損失
     総額なら全額、不足なら per-user 損失比例で按分。
  2. **Kamino 側回収分の pass-through**: Kamino の bounty 交渉 /
     recovery plan で回収された分は、Subly の手数料を一切引かず
     per-user 損失比例で全額分配する。
  3. **残損失の recovery claim 化**: reserve と回収で埋まらない分は
     per-user の claim として ledger に記録し、将来の reserve 積み増し
     から順次充当する (Drift recovery token の ledger 内簡易版。
     token 化はしない — β規模で流通させる意味がなく、譲渡可能にすると
     証券性の論点を呼ぶ)。
- 分配先はデフォルトで当該 position の agent wallet。owner が別
  アドレスを指定したい場合は owner credential 署名の指示で変更できる
  (mandate の owner 検証をそのまま流用)。

**サービス継続不能と判断した場合 (最終手段)**
- 判断基準: 損失後の TVL・収益で運営費を賄えず、かつ資金調達の目処が
  30 日以内に立たない場合。
- その場合でも **最低 30 日の安定化期間 + 14 日以上の出金猶予**を
  置いてから停止する (Carrot の清算がベンチマークとして業界に受容
  された数字)。停止後も回収分配 (上記 2) の義務は継続する。

### 0.3 反映チェックリスト

- [ ] beta-guide.md に 0.1 の開示文言を追加
- [ ] packages/pay/README.md に Risk セクション追加
- [ ] operations.md に 0.2 のテンプレ 2 種と手動 halt 手順を転記
- [ ] spending-mandate-design.md に `disclosureHash` の追記
  (mandate スキーマ変更は Phase 2 web 実装と同時で良い)

## Phase 1 — 監視と自動停止 (server 実装)

依存先の健全性を relayer が常時監視し、異常時に deposit / realize を
自動停止する。判定は保守的 (false positive 許容)。exploit は分単位で
進行する (Drift: 12 分) ため、人間の判断を待たない。

### 1.1 コンポーネント: `VaultHealthMonitor` (`src/domain/vault-health-monitor.ts`)

- `adapter.loadContext()` を定期ポーリングする。`VaultContext` に監視
  対象が全て含まれることは確認済み (`src/kamino/vault-adapter.ts`):
  `tokensPerShare` / `exchangeRateScaled` (share→USDC レート、主指標)、
  `tokenAvailableRaw` + `instantRedeemCapacityRawUsdc` (即時流動性)、
  `slot` (時刻軸)、`vaultState` (config drift 検知用)。追加のオンチェーン
  解析は不要。
- program upgrade 検知のみ追加 RPC が要る: `KLEND_PROGRAM_ID`・
  `kaminoVaultId` (いずれも adapter が import 済み)・farms program id
  (farms-sdk が export。staked shares の置き場) それぞれの
  programData account を `getAccountInfo` で取得し、last-deployed slot
  フィールドの変化で判定する (slot フィールドの位置は
  BPFLoaderUpgradeable の ProgramData レイアウトに従う。実装時に
  data 全体の hash 比較を fallback にして良い)。
- 状態機械: `healthy → halted(reason) → healthy (手動 clear のみ)`。
  自動復帰はしない。halted 中もポーリングは継続し、観測値を記録し続ける
  (解除判断の材料になる)。

### 1.2 Trip 条件 (すべて env 閾値、保守的デフォルト)

| 条件 | 判定 | デフォルト | env |
|---|---|---|---|
| exchange rate 下落 | **観測済み最高 rate (running max) 比**の下落 bps が閾値超 | 10 bps | `SUBLY_VAULT_HEALTH_MAX_RATE_DROP_BPS=10` |
| 流動性急減 | `instantRedeemCapacityRawUsdc` が時間窓内で閾値超の減少 | 20% / 10 分 | `SUBLY_VAULT_HEALTH_LIQUIDITY_DROP_BPS=2000`, `..._LIQUIDITY_WINDOW_MS=600000` |
| program upgrade | klend / kvault / **farms** (staked shares が置かれる) の programData slot 変化 | 変化即 trip | (閾値なし) |
| vault config drift | `vaultState` の admin 系 authority 変更、または withdrawal penalty (`vaultState` / `globalConfig` の両方) の引き上げ | 変化即 trip | (閾値なし) |
| 手動 | admin API / env | — | `SUBLY_VAULT_HEALTH_FORCE_HALT=1` |

設計判断のメモ:

- **rate は「いかなる減少も trip」にしない**。kvault のレートは利息で
  単調増加が期待値だが、丸め起因の微小ジッタがあり得るため閾値式にする。
  10bps は「利息で 1 poll 内に起こり得る正方向変動」より一桁大きく、
  かつ exploit 級の下落 (数百 bps〜) を確実に拾う。
- **比較基準は前回 sample ではなく running max**。前回比だと 1 poll
  あたり閾値未満で進む緩慢な流出 (slow bleed / bad debt の漸進的顕在化)
  を永久に検知できない。running max 比なら累積 10bps 超の実質的な
  価値毀損を必ず拾う。rate は単調増加が期待値なので、running max は
  実質「最後に健全だった値」と一致し、false positive を増やさない。
- **流動性急減は deposit-first 停止だから許容できる誤検知**。大口の
  正常出金と exploit を区別できないが、誤検知コストは「新規 deposit と
  realize の遅延」だけ。復旧は手動 clear。時間窓の sample は in-memory
  で持つ (再起動後は再蓄積までの数分〜10 分、liquidity trip だけ効かない。
  rate trip は永続化された running max 比なので再起動直後から効く)。
- **正規 program upgrade でも一旦止める**。Drift の教訓 (管理系操作こそ
  攻撃面)。Kamino の公式アナウンスを確認してから clear する。頻度は
  月に数回程度が想定で、運用負荷として許容範囲。
- **RPC 障害・`loadContext()` 失敗は trip しない**。可用性の問題と
  健全性の問題を混同しない。連続失敗が
  `SUBLY_VAULT_HEALTH_STALE_POLLS=10` 回 (デフォルト poll 30s ×10
  ≈ 5 分) に達したら error log + `/v1/admin/monitoring` に `stale`
  フラグを立てるのみ。stale 中は「監視できていない」ことが monitoring 上で
  見える状態にする。

### 1.3 Enforcement

差し込み点は `VaultFlowService` (`src/domain/vault-flow-service.ts`) の
4 箇所。既存の mandate 注入 (`mandates: SpendingMandateService | null`)
と同型で `vaultHealth: VaultHealthMonitor | null` を注入する
(null = 無効。テスト・detached モードは無変更で動く):

| メソッド | ゲート |
|---|---|
| `prepareDeposit` | 冒頭で assert |
| `submitDeposit` | intent 検証後・署名検証前に assert |
| `prepareWithdrawal` | `purpose === "yield_realize"` の場合のみ assert (mandate `authorizeRealize` の直前、L401 付近) |
| `submitWithdrawal` | 対象 intent の purpose が yield_realize の場合のみ assert |

- **purpose なしの通常 withdraw は prepare / submit とも素通し**
  (「出金は決して止めない」の実装)。
- 拒否は既存の `conflict(...)` ヘルパで HTTP 409、エラーコード
  `vault_health_halted`、payload に `reason` / `trippedAt` /
  `tripSlot` を含める。
- position 照会系 (`/v1/wallets/...` 等) のレスポンスに
  `vaultHealth: "healthy" | "halted"` を追加し、クライアント
  (paid-fetch / MCP tools / CLI) が警告を表示できるようにする。
- `paid-fetch` の挙動: realize が `vault_health_halted` で拒否された
  場合、agent wallet の既存 USDC 残高で支払い続行 (現行の残高優先
  ロジックのまま変更なし)。残高不足時は halt 理由を透過したエラーで
  「vault 停止中のため realize 不可」をエージェントに説明させる。

### 1.4 永続化と監査

ledger (postgres) に 2 テーブル追加。起動時 `create table if not exists`
の既存方式に従う:

- `vault_health_state` (singleton 行): `status`, `reason_code`,
  `detail_json`, `tripped_at`, `trip_slot`,
  `last_healthy_slot`, `last_healthy_exchange_rate_scaled`,
  `last_healthy_capacity_raw`, `updated_at`, `updated_by`
  (`monitor` | `admin` | `env`)。`last_healthy_*` は **rate の running
  max を観測した sample** を保持し、新しい max を観測するたびに更新する
  (trip 判定の比較基準 = 損失確定の基準点、を 1 つのレコードで兼ねる。
  永続化されるため再起動しても基準は失われない)。**halted 中は
  `last_healthy_*` を凍結する** — 事故後に rate が見かけ上回復しても
  損失確定の基準点が上書きされてはならない。更新再開は clear 後。
- `vault_health_events` (append-only 監査ログ): 全 trip / clear /
  stale 遷移を記録。clear には運用者の `reason` 文字列を必須にする。

halted は再起動を跨いで維持される (env force-halt とは独立)。
**trip 時の `last_healthy_*` が Phase 0 の損失確定と Phase 2 の分配の
基準点になる** (Core Decisions 参照)。

### 1.5 管理 API と運用

- `POST /v1/admin/vault-health/trip` / `POST /v1/admin/vault-health/clear`
  — 既存 `/v1/admin/monitoring` と同じ `SUBLY_ADMIN_API_TOKEN` 保護。
  clear は `reason` 必須。
- `GET /v1/admin/monitoring` のレスポンスに `vaultHealth` セクション
  (status / 最新 sample / stale フラグ / 直近イベント) を追加。
- env 一覧: `SUBLY_VAULT_HEALTH_POLL_MS=30000`、1.2 の閾値 3 種
  (`MAX_RATE_DROP_BPS` / `LIQUIDITY_DROP_BPS` / `LIQUIDITY_WINDOW_MS`)、
  `SUBLY_VAULT_HEALTH_STALE_POLLS=10`、`SUBLY_VAULT_HEALTH_FORCE_HALT`。監視の無効化は poll=0 ではなく
  `SUBLY_VAULT_HEALTH_DISABLED=1` を明示させる (production では
  monitoring に警告を出す)。
- clear の運用手順 (operations.md に転記): (1) Kamino 公式チャネル
  (X / status) で異常有無を確認 (2) rate / 流動性の観測値が回復して
  いることを monitoring で確認 (3) trip 理由が program upgrade なら
  公式アナウンスと突合 (4) clear API を reason 付きで実行。

### 1.6 Trip 時に in-flight のフローがどうなるか

- prepared (未 submit) の deposit / realize: submit 側ゲートで拒否 →
  120s expiry で自然消滅 (既存機構)。
- submitted (broadcast 済み・未 confirm): 取り消せない。既存の確認・
  reconcile 機構 (`vault_flow_pending` の解決) に任せる。confirm された
  deposit は事故に巻き込まれた可能性があるが、これは「poll 間隔より
  速い事象は止められない」という本設計の明示的な限界の一部。
- 実装規模: monitor 本体 ~200 行 + ゲート ~40 行 + admin API ~40 行 +
  env/runtime 配線 + テスト。既存パターン (mandate 注入、
  `sponsorMonitoring` と同居する runtime.ts 配線) の踏襲で数日規模。

## Phase 2 — Safety reserve (資本の手当て)

perf fee 徴収は未実装であるため、Phase 2 は「fee 会計」と「reserve」を
分けて設計し、reserve は fee 実装を待たずに立ち上げる。

### 2.1 Reserve の器

- **専用ウォレット (reserve wallet) を 1 つ用意し、アドレスを公開する**。
  運転資金と物理的に分離し、relayer サーバーには秘密鍵を置かない
  (reserve は支払う必要が生じるまで動かさないコールド資金)。
- β期間: 運用者管理の単独鍵 (オフライン保管)。**残高が $10k を超えた
  時点で Squads 2-of-3 multisig に移行する** (署名者: 運用者 + 独立した
  2 名。移行自体もアナウンスする)。
- 透明性: `GET /v1/admin/monitoring` とは別に、公開エンドポイント
  (または docs 掲載) で reserve アドレス・現在残高・目標水準を常時
  開示する。残高は RPC で誰でも検証できる。

### 2.2 積立ルール

- **Seed**: β開始時に treasury から **$1,000** を入金する。これは
  目標バンド上限 (TVL の 5%) を TVL $20k まで満たす額であり、
  **β TVL が $20k に近づいたら seed を増額してバンド内を維持する**
  (全額補償を意味しない — 補償能力は常に「reserve 残高 + 回収
  pass-through + claim」であり、それ以上を示唆しない)。
- **Perf fee 導入後**: 徴収した perf fee の一部を reserve に回す。
  積立率は次項のバンドルールで決まる (50% または 10%)。
- **目標水準: TVL の 2%〜5% のバンド**。2% を下回ったら積立率 50%、
  5% に達したら 10%、バンド内 (2-5%) は直前の積立率を維持する
  (hysteresis — 境界付近での頻繁な切替を避ける)。全損はカバーできない水準である
  ことを開示で正直に言う (「TVL の 2-5% + 回収 pass-through + claim」
  が Subly の補償能力の全てであり、それ以上を示唆しない)。
- perf fee の会計設計 (fee 実装時の指針、本設計の管轄はここまで):
  realize 時に実現 yield に対して perf fee bps を ledger 上で accrue し
  (既存 `feeDebtRawUsdc` と同じ ledger-accrual パターン)、withdraw 時
  または月次 sweep で徴収、徴収額の 50% を reserve wallet に送金する。
  on-chain で徴収を tx に組み込む設計は canonical tx を複雑化するので
  採らない。

### 2.3 取り崩しと分配

- 取り崩し条件: Phase 0 プレイブックの補償優先順位 1 に該当する場合のみ。
  平時の流用は禁止 (multisig 移行後は署名者がこの規律の執行者になる)。
- 分配額: `min(reserve 残高, 損失総額)` を per-user 損失比例で按分。
  per-user 損失は Phase 1 の trip snapshot 基準 (0.2 参照)。
- 分配先: デフォルト agent wallet、owner credential 署名で変更可
  (0.2 参照)。
- 分配後の残 claim は ledger に記録し、reserve が積み上がり次第
  同一比率で追加分配する。claim は譲渡不可・token 化しない。

## Phase 3 — 構造的分散 (TVL ラダーで発動)

### 3.1 発動条件 — TVL ラダー

| TVL | 要求 |
|---|---|
| < $250k | 単一 venue (Kamino) で可。reserve + treasury で部分補償が現実的な規模 |
| $250k〜$1M | **2 venue 以上、単一 venue 上限 70%**。第 2 venue の統合を $250k 到達前に完了させる (到達を発動トリガーにすると間に合わないため、$150k 到達時点で統合作業を開始する) |
| > $1M | **3 venue 以上、単一 venue 上限 50%** |

数値の根拠: 上限 70% / 50% は「単一 venue 全損でも TVL の 30-50% が
無傷で残り、事業とユーザー基盤が存続できる」ことを狙った blast-radius
制御であり、reserve (2-5%) で損失を全額埋められるという意味ではない。
Carrot (露出 50% で清算) を下回る露出に抑える、が 50% 上限の由来。
数値は運用実績で見直して良いが、**緩める変更はユーザー告知後 30 日を
経てから**とする。

### 3.2 Venue 抽象化

- 現在の `KaminoVaultAdapter` の public surface (`loadContext` /
  `getUserSharesRaw` / `quoteSettlementWithdraw` /
  `buildSettlementWithdrawInstructions` / `buildDepositInstructions` /
  `buildNormalWithdrawInstructions` / `loadLookupTables`) を
  `YieldVenueAdapter` interface として切り出す。`VaultContext` の
  venue 固有フィールドは共通指標 (exchange rate scaled / 即時流動性 /
  slot) + venue 固有 opaque データに再編する。
- **Phase 3 発動までにやって良いのはこの interface 切り出しまで**
  (振る舞いを変えないリファクタ)。第 2 venue の実装は発動条件まで
  着手しない。
- `VaultHealthMonitor` は venue ごとに 1 インスタンス。halt も venue
  単位 (Kamino halt 中でも venue B の deposit / realize は生きる)。
- position は venue 単位で保持する (現行 ledger の wallet×vault キーが
  既に venue 概念を内包している)。損失も venue 単位で分離され、
  被弾 venue に position を持つユーザーだけが影響を受ける。

### 3.3 配分ルール

- 新規 deposit は「上限に達していない venue のうち、ユーザー (owner
  mandate) が許可したもの」へ。venue 選択は owner 承認画面で明示する
  (どの venue にいくら入るかを承認対象に含める)。owner が許可した
  venue がすべて上限到達済みの場合、deposit は**拒否**し「他 venue の
  許可追加 or 上限解放待ち」を案内する (上限を破る例外は設けない)。
- **強制リバランスはしない**。上限超過が発生した場合 (相場変動や出金の
  偏りによる) は新規 deposit の routing だけで是正し、既存 position の
  強制移動はユーザー同意なしに行わない (移動 = 一旦 withdraw + 再
  deposit であり、owner 承認の原則を破れない)。
- 第 2 venue の選定基準 (チェックリスト、選定時に評価を docs 化する):
  監査数と形式検証の有無 / bug bounty 規模 / TVL とその年数 /
  過去のインシデント履歴と対応 / oracle 依存構成 / 管理権限の timelock
  有無 / 出金の即時性。Drift 系は事故直後につき除外。現候補:
  MarginFi、Solend (Save)、Lulo 経由 (Lulo は自身が分散するため
  single-integration で分散が買えるが、Lulo 自体が追加の contract
  リスクになる点を評価に含める)。

### 3.4 採らないと決めたもの

- **Lulo Protect 型 Protected/Boosted トランシェ**: 不採用。first-loss
  を引き受ける Boosted 側資本の厚みが必要で、βの TVL 規模では市場が
  成立しない。**TVL $5M 到達時に再評価** (その規模なら reserve では
  薄すぎ、トランシェの構造的カバーに優位性が出る)。
- **外部保険 (Amulet 等) の標準組込み**: 不採用。Solana の保険市場の
  厚み・継続性が不足。Phase 3 発動時に再評価し、venue 追加と保険購入の
  コスト対効果を比較する。

## 残存リスク (対策後も残るもの — 開示と整合させる)

1. **poll 間隔より速い事象は事前に止められない**。検知は最速でも
   poll 間隔 (30s)。Drift 型の 12 分ドレインには間に合うが、1 poll 内で
   完結する exploit には「新規流入と realize を事後に止める」効果に
   留まる。検知の高速化 (websocket 購読・slot 単位監視) は Phase 1 の
   運用実績を見てから検討する。
2. **vault 内の既存元本は守れない**。本設計の全てをもってしても、事故の
   瞬間に vault 内にある元本の損失自体は防げない。補償は reserve の
   範囲 + 回収 pass-through まで。
3. **単一 RPC への信頼**。監視も執行も同一 RPC を信頼する。RPC が
   虚偽データを返せば検知は無効化されるが、これは relayer 全体の
   trust base と同一であり、本設計で単独に対策しない (RPC 多重化は
   relayer 全体の課題として別途)。
4. **監視自体の停止**。relayer プロセスが落ちれば監視も止まる。ただし
   その場合 deposit / realize も止まる (同一プロセス) ため、
   「監視なしで資金が動く」状態にはならない。fail-closed。
5. **人間の解除ミス**。clear は手動だが、運用者が誤認して早期解除する
   リスクは手順 (1.5) と監査ログでしか縛れない。

## 説明テンプレ (指摘への回答)

> Kamino が exploit された場合、vault 内の元本は失われえます。これは
> ゼロにできないリスクであり、私たちは隠しません (開示文書への owner
> 署名で同意を取得)。その上で Subly は: (1) 元本は人間の生体認証承認
> なしに DeFi に入らず、支払いバッファとは分離されている (2) relayer が
> vault の健全性 (exchange rate / 流動性 / program upgrade / 管理権限
> 変更) を常時監視し、異常時は新規投入と換金を自動停止する。ユーザーの
> 出金経路は決して止めない (3) 収益 (performance fee) の一部を公開
> アドレスの safety reserve として積み立て、事故時の補償原資とする
> (4) 事故時の対応手順・開示・補償優先順位・清算時の出金猶予まで事前に
> 文書化済み (5) TVL の成長に応じて複数プロトコルへの分散と露出上限を
> 発動する — という 5 点で「被害の限定」と「事業の継続」を担保します。
> 業界の実例 (Drift exploit で下流の Pyra/Carrot が消え、露出管理と
> 自己補償をした Piggybank/Lulo が生き残った) が示す通り、この差が
> 製品の生死を分けます。

## Review Log

- **v1 (2026-07-04)**: 初版 (調査 + 3 層の方針 + Phase 1 の feasibility
  検証)。
- **v2 review round 1** — 検出・修正した指摘:
  1. 管理 API の認証を「owner-pages / mandate 系と同様」と書いていたが、
     既存の管理系は `SUBLY_ADMIN_API_TOKEN` 保護 (`/v1/admin/monitoring`)
     であり、そちらに統一 (1.5)。
  2. フローが prepare→submit の 2 段階 (expiry 120s) であることを
     見落とし、prepare のみのゲートでは prepare 後 trip のケースが
     素通りする。submit 側 (submitDeposit / submitWithdrawal) にも
     ゲートを追加 (1.3, Core Decisions)。
  3. 「halted 中も withdraw を通す」は信頼できないレートでの出金を
     許すことと等価だが、v1 はこれを明示していなかった。意図した設計で
     あることと理由を明記 (Core Decisions)。
  4. 損失確定の基準点が未定義だった。trip 時の last-healthy snapshot を
     永続化し、検知・損失算定・補償分配が同一基準を参照する構造に (1.4,
     0.2, 2.3)。
  5. Phase 2 が perf fee 実装を暗黙の前提にしていた。fee 未実装の現状を
     明記し、treasury seed ($1,000) で fee 実装を待たず reserve を
     立ち上げる構成に変更 (2.2)。
  6. Phase 3 の発動条件「reserve でカバー不能な規模」が定量でなく
     執行不能だった。TVL ラダー ($250k / $1M) と着手トリガー ($150k) に
     数値化 (3.1)。
  7. トランシェ・外部保険を「検討項目」と曖昧に残していた。不採用と
     再評価トリガー (TVL $5M / Phase 3 発動時) を決定 (3.4)。
- **v2 review round 2** — 検出・修正した指摘:
  1. 開示文言に USDC depeg の扱いがなく、脅威モデルのスコープ外宣言と
     不整合だった。開示文言に対象外である旨を追加 (0.1)。
  2. 監視無効化の経路が暗黙 (poll 間隔の悪用) に開いていた。明示 env
     (`SUBLY_VAULT_HEALTH_DISABLED`) 必須 + production 警告に (1.5)。
  3. reserve 積立率が固定 50% だと reserve 充足後に過剰積立になる。
     目標バンド (2-5%) 連動の 50%/10% 切替に (2.2)。
  4. 「trip 中に submitted 済みの in-flight フローはどうなるか」が
     未記述だった。追加 (1.6)。
  5. Phase 3 の露出上限を「緩める」変更に手続きがなかった。30 日
     事前告知を要件化 (3.1)。
- **v2 review round 3** — 検出・修正した指摘:
  1. 開示文言「お預かりする USDC」が non-custodial の主張と矛盾。
     「Subly が預かるものではない」に修正 (0.1)。
  2. `disclosureHash` の同意取得点が mandate 署名と個別 deposit 承認で
     曖昧だった。mandate 署名で一度取得 + deposit 承認画面には要旨
     リンク常置、に確定 (0.1)。
  3. 損失算定式が「snapshot 後に不利なレートで出金して脱出した
     ユーザーの実現損」を扱えなかった。受領額を式に追加 (0.2)。
  4. rate trip の比較基準が「前回 sample 比」だと、1 poll あたり閾値
     未満で進む slow bleed (bad debt の漸進的顕在化) を永久に検知
     できない。running max 比に変更し、`last_healthy_*` (損失基準点)
     と比較基準を同一レコードに統一 (1.2, 1.4)。
  5. program upgrade 監視から farms program (staked shares の置き場) が
     漏れていた。追加 (1.2)。
  6. config drift の penalty 監視が `vaultState` のみで、
     `globalConfig` 側の penalty (実効値は両者の max) が漏れていた。
     追加 (1.2)。
  7. reserve seed $1,000 の説明「β規模の事故なら全額補償」が過大主張
     だった (β想定 TVL 数万 USDC に対し矛盾)。「TVL $20k までバンド
     上限 5% を満たす額、$20k 接近で増額」に修正 (2.2)。
  8. owner が許可した venue が全て上限到達のときの deposit 挙動が
     未定義だった。拒否 + 案内と明記、上限の例外なし (3.3)。
- **v2 review round 4** — 検出・修正した指摘:
  1. halted 中に rate が見かけ上回復すると running max (= 損失確定の
     基準点) が上書きされる。halted 中は `last_healthy_*` を凍結 (1.4)。
  2. 流動性監視の時間窓が in-memory であり、再起動直後は liquidity
     trip が効かない期間があることが未記載だった。挙動を明記 (rate
     trip は永続化基準のため再起動直後から有効) (1.2)。
- **v2 review round 5** (全文通読) — 検出・修正した指摘:
  1. 1.2 の trip 条件表に追加した farms program が、1.1 の upgrade
     監視対象の記述に未反映だった。1.1 に追加。
  2. 脅威モデル S4 が「allocation 改変」を検知対象と示唆していたが、
     config drift 検知は authority / penalty のみ (allocation 変更は
     curator の正常リバランスと区別できない)。S4 を「直接 trip せず
     rate / 流動性で間接検知」に訂正。
  3. 1.5 の「閾値 4 種」が実際の env 数 (3 種) と不一致。stale 判定を
     `SUBLY_VAULT_HEALTH_STALE_POLLS` として env 化し、一覧を実数に
     訂正 (1.2, 1.5)。
  4. reserve 積立率の切替条件が 2.2 内の 2 箇所で微妙に異なる表現
     だった (「目標水準を満たしたら」vs「5% に達したら」)。バンド
     ルールに一本化し、バンド内 (2-5%) の挙動を hysteresis として
     定義 (2.2)。
- **v2 review round 6**: 全文の相互参照・数値整合の最終確認 (閾値と
  env 名 / 積立率とバンド / ラダー数値と着手トリガー / 脅威モデル
  S1-S5 と Phase の対応 / Review Log と本文の修正内容の一致)。
  新規指摘なしで終了。

## Implementation Notes

- 2026-07-04: v1 作成 (調査 + 設計)。同日 v2 で全フェーズ詰め切り
  (レビュー 6 round、指摘計 26 件を検出・修正、round 6 で指摘ゼロ)。
  実装は全 Phase 未着手。Phase 0 は実装不要のため、次アクションは
  0.3 チェックリストの転記。
- 既存資産との対応: yield-only guard (`src/domain/vault-flow-service.ts`
  `prepareWithdrawal`) = 支払い側の構造的上限 / spending mandate
  (`src/domain/spending-mandate-service.ts`) の revoke = ユーザー側
  kill switch / deposit owner 承認 = リスク引受の同意点。本設計が
  追加するのは「依存先の健全性」を見る relayer 側の自動 kill switch と
  資本 (reserve)・分散 (venue ladder) の規律。

## 参考 (2026-07-04 調査)

- Drift exploit: news.bitcoin.com "Drift Protocol Hack 2026" /
  chainalysis.com "Lessons from the Drift hack" / drift.trade
  "Incident Recovery Update – April 16, 2026" / continuuminsure.com
  (Insurance Fund は exploit 非対象)
- 下流の明暗: crypto.news "Pyra to shut down" / cryptotimes.io
  "Carrot Becomes First DeFi Casualty" / phemex.com "11 DeFi Platforms"
- Euler 2023: tokeninsight.com "11 DeFi Protocols Suffer" /
  euler.finance "War & Peace: $240M Exploit Recovery"
- Loopscale 2025: invezz.com (bounty で全額回収) / helius.dev
  "Solana Hacks: A Complete History"
- Lulo Protect (first-loss トランシェ): docs.lulo.fi/protect
- Kamino 防御態勢: certora.com "Securing Kamino Lending" /
  docs.kamino.finance/risk/risk-assessment-framework /
  immunefi.com/bug-bounty/kamino
- 保険: nexusmutual.io / Amulet (solanacompass.com insurance category)
