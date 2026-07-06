# Subly Business Model — 収益アーキテクチャと配布戦略

作成: 2026-07-07 JST / Status: **方針確定・徴収未実装**。
2026-07-02 に確定した基本方針(収益 = TVL × パフォーマンスフィー、決済手数料は
取らない)を、mandate 層 / custody 対応 / privacy 設計を踏まえた実行計画に展開する。

> 前提となる確定事項 (2026-07-02):
> - One-liner: **"Your yield pays your agent's API bills."**
> - 収益は TVL × パフォーマンスフィー 15–20%。決済 volume 課金は構造的に不成立:
>   x402 経済圏全体で累計 ~$40–50M / Base 直近 30 日 ~$1.2M、Coinbase
>   facilitator が $0.001/settlement でレール価格を釘付けにしており、決済手数料で
>   収益を上げている x402 企業は存在しない。「利回りで払う」の看板とも矛盾する。
> - ピッチの枠組みは「エージェントの deposit/treasury インフラ」(バランスシート
>   経済)であり、決済企業ではない。
> - **現状、フィー徴収機構はコードに存在しない**(手数料まわりは feeDebt =
>   スポンサーガス代の回収のみ)。収益はゼロ instrument の状態。

## Core Thesis — 「決済」ではなく「エージェントの資金管理」で課金する

Subly の資産構成(yield-only guard、spending mandate + passkey HITL、custody
signer 対応、AP2 型監査チェーン、PSP/omnibus privacy 設計)を並べると、これは
**エージェント版 Ramp/Brex + 利回り付き当座口座**である。位置づけ:

- **決済レール(x402 支払い)= 獲得フック。恒久無料。** 資金がここに置かれる
  理由を作る装置であり、課金対象ではない。
- **預かり残高(TVL)= 収益源。** ユーザーの遊休資金が利回りを生み、Subly は
  その利回りの一部を成功報酬として受け取る。
- **mandate 層 = 企業導入のアンロック。** コンプラ装飾ではなく、財務部門が
  エージェント支出を許可するための必須機能(caps・閾値承認・kill switch・監査)。

「我々はあなたの元本に触れない。実際に使われた利回りの一部だけを受け取る」
という料金体系そのものが、資金を預かる事業の信頼獲得装置になる。

## 収益アーキテクチャ — 3 層を順に積む

### 第 1 層 (いま): realized yield への成功報酬 15–20%

- **徴収ポイントは 2 箇所に絞る**: (a) `yield_realize` 時(x402 支払いのために
  利回りを引き出した瞬間)、(b) exit withdraw 時の実現益。既存の
  principalBasis 会計(position value − principal basis = gross yield)が
  そのまま課金根拠になる。
- **未実現分・放置ユーザーからは取らない。** 「使った/引き出した利回りの
  15% だけ。元本と未実現益には一切触れない」— 営業上も強く、TVL の定着にも効く。
- 預入・引出手数料は取らない(摩擦は TVL の敵)。ガスコストは既存の feeDebt
  機構で回収済み。

### 第 2 層 (6–12 ヶ月): 運用レイヤーのマネジメントフィー

- protocol-dependency-risk 設計の **venue ladder**(Kamino 単独 → 複数 venue
  分散)を実装した時点で、配分の付加価値に対して **TVL の 0.25–0.5%/年** を追加。
- パフォーマンスフィーの **10–20% を safety reserve に積んで公開する**
  (docs/protocol-dependency-risk.md の reserve 設計と接続)。フィーが信頼資産に
  変わり、1 ユーザーあたり預入額の上限を押し上げる。

### 補助エンジン (収益ではない): discount flywheel / seller-side take rate

- **Discount flywheel(獲得エンジン)**: ユーザーごとの割引予算 = 自分の預入の
  利回り × (1 − Subly cut) を pro-rata で配る。予算の出所が本人の利回りなので
  フリーライドが構造的に成立しない。これは獲得装置であり収益ではない
  (2026-07-02 決定を踏襲)。
- **Seller-side take rate (5–15%)**: GMV ~$50k/月 を超えてから検討する
  オプション。それ以前に持ち出すと buyer-side 中立性の看板を毀損する。

### 第 3 層 (後回し): B2B spend-management SaaS + PSP float

- **組織向け機能を月額課金**: 複数ウォレット管理、mandate 管理コンソール、
  監査エクスポート、webhook 通知、SLA。目安 $49–199/月/org(+ perf fee)。
  mandate 層はエージェント支出を統制したい企業にはそれ単体で予算が付く。
- **PSP float 収益**(docs/payment-privacy-design.md の omnibus 設計): 第三者
  秘匿を必要とするチームの決済 float 自体が利回りを生む — 決済業の王道収益。
  ただし資金移動業の規制負荷が最重量なので、**順序は必ず最後**。

## フィー徴収の実装設計 (Phase A / B)

非カストディ設計のため Subly がユーザーの vault shares を勝手に動かすことは
できない。2 段階で入れる:

- **Phase A — 会計上の accrual(小さい変更、先行導入)**: realize / exit
  confirm 時に `perfFeeAccruedRawUsdc` を position に加算し、feeDebt と同様に
  spendable yield から控除する。経済的にはこの時点で課金が成立し(ユーザーが
  使える利回りが減る)、料金の可視化(budget 応答・spending log への表示)も
  ここで行う。USDC の実移転は未実施のまま。
- **Phase B — 実移転**: realize / exit のトランザクションに Subly treasury
  ATA への `TransferChecked`(金額 = accrued fee)を 1 本追加し、
  `transaction-intent-validator` に正確な許可パターン(宛先 = treasury ATA
  固定、金額 = intent の fee フィールド一致)を追加する。agent は署名時に
  fee を含む structured intent を検証できるため、非カストディの検証境界は保たれる。

価格: β 参加者は **15% で grandfather**、GA で **20%**。
**課金ゼロのまま TVL を集めない** — 後からのフィー導入は解約イベントになる。

## 配布戦略 — TVL は誰から来るか(ここがモデルの本体)

個人ホビイストの $50 預入では TVL は積み上がらない。狙う順:

1. **API 課金を実際に払っている AI スタートアップ / エージェント運用チーム。**
   Nansen・検索・推論 API の前払い残高(float)を既に持っている。ピッチ:
   「その遊休予算が利回りを生み、エージェントは利回り分しか使えず、財務は
   caps と監査と kill switch を握る」— CFO に通る話。1 社 $10k–100k 級。
2. **プラットフォーム組み込み (B2B2C)。** custody signer 対応(Circle/Privy)
   済みの今、OpenClaw 型ハーネスやエージェントウォレット基盤に「Subly inside」
   + レベニューシェアを提示できる。1 統合 = 数千ウォレットで配布コストの
   構造が変わる。
3. **個人ユーザーはコミュニティと実績作り**(closed β の役割)。収益貢献は
   期待しない。

**未決の意思決定ポイント**: 2026-07-02 時点では consumer-first で始める意向
(B2B agent-treasury が TVL 最速と認識した上での選択)。本ドキュメントは TVL
効率から fleet/B2B 優先を推奨しており、ここは意識的に選び直す必要がある。
両立案: β の器は consumer のまま、設計パートナー営業(fleet 1–3 社)だけ
並走させ、どちらの預入曲線が立つかで GA の主導線を決める。

## ユニットエコノミクス(正直な算数)

```text
収益率  ≈ perf fee 17.5% × USDC 利回り ~6% ≈ TVL の ~1%/年
$100k ARR ≈ TVL $8–10M
$1M   ARR ≈ TVL $70–100M (アグリゲーター規模)
```

- 第 1 層単独では「小さくて良い事業」止まり。スケールには **配布 (2) か
  SaaS 層 (3) のどちらかが必須**。
- 良い側の事実: 典型的エージェントの支出(数セント/日)は **$500–5k の預入で
  賄える**($1k × 6% ≈ $0.16/日)。「利回りで払い切れる」という製品の約束は
  小口でも成立する。yield-funded の性質上、支出上限より先に spendable yield が
  尽きる設計(spending-mandate-design.md の試算)とも整合。

## KPI

- **North star: yield だけで稼働した agent-days**
- TVL / funded wallet 数 / 平均預入額
- 月次 realize 額(= 実決済需要)/ 預金残存率(退蔵ではなく残高の粘着)
- マイルストーン: TVL $100k (β) → $1M (fleet 顧客 1–3 社) → $10M
  (プラットフォーム統合 1 件) ≈ $100k+ ARR

## 直近アクション

1. **フィー徴収 Phase A の実装**(accrual + budget/spending-log への表示)。
2. **料金ページ 1 枚の公開**: perf fee / 決済 0 円 / 預入・引出 0 円 /
   reserve 積立率。「何で儲けるか」を先に言うこと自体が信頼獲得。
3. fleet 候補(API 支出のある AI チーム)への設計パートナー打診を β 拡大と併走。

## リスク

- **利回り圧縮**: USDC 金利低下は収益とユーザー価値を同時に沈める → venue
  ladder(第 2 層)でヘッジ。
- **バンドル競合**: Coinbase/CDP が「yield-funded agent spend」を抱き合わせる
  可能性 → モートは「どの標準 x402 セラーでも動く中立性 + 非カストディ +
  mandate 監査チェーン」。
- **規制解釈**: 成功報酬モデルは投資助言/運用該当性の論点になり得る →
  非カストディ + ユーザー自身の署名境界が防御線。PSP float(第 3 層)は
  資金移動業そのものなので最後に、単独で法務検討してから。

## 参照

- `docs/spending-mandate-design.md` — B2B アンロックとなる HITL/監査層
- `docs/protocol-dependency-risk.md` — venue ladder / safety reserve
- `docs/payment-privacy-design.md` — PSP/omnibus(第 3 層 float 収益の器)
- `.superstack/review-2026-07-06.html` — フィー機構未実装の確認を含む直近レビュー
