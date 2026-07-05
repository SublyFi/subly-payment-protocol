# Subly Payment Privacy Design — 第三者秘匿のための Omnibus Settlement

作成: 2026-07-05 JST / Status: **検討完了・実装未着手 (設計メモ)**。

> 背景: 「x402 で Buyer → Seller に送金するとき、**どの Buyer がどの Seller に
> 払ったかを第三者 (オンチェーン観測者) に分からないようにできないか**」という
> 問いへの回答。2026-07-05 に最新のプライバシー技術 (Solana Confidential
> Balances / Circle Arc Privacy / TACEO Merces / Arcium+Umbra / Privacy Cash)
> を調査した結果、**mixer / shielded pool 型は Subly のコア (yield-funded ×
> マイクロ決済) に対して三重にミスマッチ**であり乗せるべきでないと結論した。
> 一方、要件が「**運営 (Subly) には見えてよい、第三者にだけ隠れればよい**」で
> あれば、mixer は不要で、**Subly を決済アグリゲーター (PSP) にする**ことで
> ほぼ無コスト・yield 両立で達成できる。本書はその設計を記す。

## 要件の確定

- **守る相手**: 第三者 = オンチェーン観測者。「Buyer X が Seller Y に払った」を
  相関できないようにする。
- **守らない相手 (=見えてよい)**: Subly 運営自身。Seller も HTTP 層では
  取引相手なので対象外 (Seller にも隠す場合は別スコープ、末尾参照)。
- **保護対象の粒度**: on-chain の Buyer↔Seller リンク。金額そのもの
  (Seller の価格) は公開で構わない。

この「第三者にだけ隠す」という緩和が設計を根本的に軽くする。**mixer は
「運営にも隠す」ための道具**であり、本要件には過剰かつ不適。

## なぜ mixer / shielded pool を採らないか (却下記録)

2026-07-05 の調査で確定した事実。詳細は memory `subly-x402-privacy-investigation`。

1. **金額秘匿系は要件外**: Solana Confidential Transfer (Token-2022) / Circle
   Arc Privacy / TACEO Merces はいずれも**金額を暗号化するが送受信者アドレスは
   公開のまま**。「どの Seller に払ったか」は隠れない。
2. **linkage 切断系 (Umbra / Privacy Cash) はコストが破綻**: 引き出し固定費が
   ~$1 (Privacy Cash: 0.006 SOL/宛先 + 0.35%)。x402 マイクロ決済 ($0.001–0.1)
   に対し **10–100 倍のオーバーヘッド**。1 決済ごとに fresh wallet を使えば
   本当に隠れるが経済破綻。まとめて償却すれば同一 wallet から複数 Seller が
   クラスタ化して非リンク性が壊れる (コスト償却 ↔ 匿名性はトレードオフ)。
3. **利回りに反する**: shielded pool に置いた資金は利回りを産まない。「利回りを
   産みながら隠す」ために shielded な Kamino ktoken で準備金を持つ案を検討したが、
   **Umbra は固定 allowlist (wSOL/USDC/USDT/UMBRA/CASH/ZINC) で ktoken 非対応**。
   仮に専用 pool を立てても ktoken を shield するのは Subly だけ = anonymity
   set 1 で匿名性ゼロ。mixer の匿名性はメジャートークンの大量プール由来なので、
   ニッチな利回りトークンを隠す発想自体が非両立。

**結論: mixer 型はコア非対応。** 成立するのは大口・低頻度 (B2B 精算 / treasury)
= 別プロダクト。Subly のマイクロ決済コアには Omnibus 方式を採る。

## Core Decisions

1. **Subly = 決済アグリゲーター (PSP)**。x402 の支払い元を per-user agent wallet
   から **Subly 管理の共有 omnibus アカウント**に変える。Seller が受け取るのは
   常に「omnibus → Seller」。第三者にはどの Buyer かが見えない。匿名性の母集団
   (anonymity set) = その omnibus を経由する全 Buyer。mixer 手数料なし、通常 tx
   代のみ。
2. **決済は float から即払い、Buyer 資金は決済時に動かさない**。omnibus は常時
   USDC float を持ち、決済の瞬間はそこから払う。Buyer の持ち分は**オフチェーン
   ledger を debit するだけ**。float の補充は別タイミングで batch realize。
   これにより「Seller への出金」に時刻一致する「Buyer の入金」が存在せず、
   **タイミング相関を断つ** (§相関攻撃)。
3. **実質プリペイド + 決済遅延。本物の与信 (postpaid) にはしない**。Subly は
   常に「その Buyer が**既に稼いだ・claim 可能な yield**」の範囲内でだけ立て替える。
   将来 yield を見込んだ立て替え = 信用供与 = lending 規制 + デフォルトリスクは
   禁止。この上限チェックは既存の **yield-only guard がそのまま兼ねる**
   (technical-design.md / `purpose: "yield_realize"`)。
4. **Buyer principal は self-custody のまま、Subly は realize-delegate 権限のみ**。
   プライバシーに必要なのは共有*決済* float であって、Buyer principal の
   プール custody ではない。principal は per-user Kamino position に置いたまま、
   Subly は「立て替え分を精算するための realize 権限 / lien」だけ持つ (軽い構成)。
   pooled custody (重い = 資金移動業 / stored-value 規制) は採らない。
5. **真実の残高はオフチェーン ledger。TEE で attestable にする**。batch 化と
   プライバシーの両立には ledger をオフチェーンに持つしかない (on-chain に書くと
   相関が漏れる)。TEE で「正しく更新した証明」を出し、spending-mandate の
   selective disclosure と接続することで「Subly の帳簿を信じろ」問題を埋める。

## Non-goals

- **Seller に対する Buyer 秘匿**。Seller は HTTP 層で Buyer 識別子
  (`wallet-auth-headers.ts`) を見得る。第三者秘匿が要件なので対象外。
- **運営 (Subly) からの秘匿**。Subly は ledger で全取引を見る。これが許容される
  という要件確定が本設計の前提。
- **on-chain での ledger / mandate 強制**。強制点は relayer / TEE。
  technical-design.md の Non-goals と同じ (relayer/TEE attestation を claim とする)。
- **mixer 級の unlinkability**。母集団 = 同時利用者数に依存し、統計相関は
  ゼロにならない (§残存リスク)。

## x402 プロトコル互換性 — 「Subly が払う」は仕様上合法

x402 の `exact` スキームで facilitator が検証するのは以下だけ (docs.x402.org):
`payTo` に正しい `asset` (USDC mint) が正しい `amount` 届くか / **支払い元
アカウントの鍵で有効に署名されているか** / リプレイでないか。

- facilitator が縛るのは「**署名 ↔ 支払い元アカウント**」(自分が支配しない口座から
  勝手に引き落とす偽造を弾く) であって、「支払い元 ↔ HTTP リクエストを出した Buyer
  本人」ではない。facilitator はそもそも "エンド Buyer が誰か" を知り得ない。
- よって **Subly が omnibus の鍵で署名して omnibus から払う**のは自明に有効。
  Buyer の鍵はオンチェーン署名に一切使わない。Buyer の承認はオフチェーン
  (spending mandate / HTTP 認証) に移る。
- Subly は既にサーバー側で決済を組み立て署名している (relayer が realize →
  fee payer として最後に署名)。**変更は「TransferChecked の source ATA を
  agent wallet から omnibus に差し替え、署名鍵を omnibus にする」だけ**。
  命令列の形 (compute-budget + TransferChecked) は不変なので、PayAI 等の
  exact verifier は source の身元を見ず、そのまま通る。
- 前例: gasless / facilitator 代理 settle は標準 (EIP-3009 transferWithAuthorization)、
  prefunded balance / アグリゲーター型も既存 (Circle Gateway Nanopayments が近い形)。

**一次仕様での裏付け** (x402-foundation/x402、2026-07-05 確認):

- **リソースは払った人でなく HTTP リクエスタに返る**: "The resource server returns
  the protected resource in the HTTP response to the client (who sent the request
  with a valid PAYMENT-SIGNATURE header). The resource is not delivered directly to
  the on-chain payer if the payer is different from the HTTP requester."
- **`from` (支払い元) は requester と別**: payload の `authorization.from` は
  "the actual source of the payment on-chain, not necessarily the HTTP
  requester/session"。
- **第三者 payer を第一級サポート**: "a third party can be the source/payer of the
  payment, and the server can still fulfill the request for the client" (Sponsor /
  Facilitator)。SVM exact は Sponsor が feePayer、`extra.feePayer` で宣言。

→ 「誰が払うか (`from`)」と「誰にリソースが返るか (requester)」が仕様レベルで分離
しているため omnibus は想定内。**最もクリーンな当てはめ = プロキシ方式で Subly 自身が
x402 client になる** (requester も payer も Subly で一致、受け取ったリソースを Buyer に
手渡すのは x402 の外)。この形なら逸脱ですらない。仕様が明示する第三者は主に feePayer
(ガス) の例で、omnibus は value の `from` 自体を omnibus にする一歩進んだ形だが、
上記 3 点から成立する。

**注意**: 特定 Seller の facilitator が独自に「payer フィールドが何かと一致」を
追加検証する実装なら個別対応が要る。標準 exact スキームは支払い元身元を縛らない。

## リソース配送 — Buyer は有料 API を使えるか (Yes)

「Subly が代わりに払う」= 「Buyer が使えなくなる」ではない。x402 は**有料
リクエストを出した相手 (HTTP コネクション保持者) にリソース (API 本体) を返す**。
「誰が払ったか」と「誰がレスポンスを受け取るか」は別で、payer = omnibus でも
リクエスト保持者にレスポンスが届く。

現状の `src/client/standard-x402-payer.ts` が既にこの配送をしている:
`probe(402) → realize → x402Fetch(支払い+リトライ) → response.text() で body 取得
→ { paid:true, status:200, body } を Buyer の agent に返す`。**Subly は既に
fetch-and-relay プロキシ**であり、omnibus 化は支払い元 (source ATA) を
agent wallet → omnibus に差し替えるだけで、body を返す配送経路は不変。

リクエストの起点は 2 通り、どちらも配送される:

- **(1) Subly がプロキシ (現状のまま・推奨)**: Subly が Seller に叩き omnibus で
  払いレスポンスを Buyer agent に中継。副作用 = Subly がレスポンス本体を見る
  (Subly 信頼前提と整合)。
- **(2) Subly が request 束縛済み支払いトークンを発行、Buyer が直接 fetch**:
  Subly はレスポンスを見ないが Seller が HTTP 層で Buyer を見る (Seller 秘匿は
  Non-goal なので許容)。

**むしろ速くなる**: omnibus は float から即払い (realize はクリティカルパス外)。
今日の「realize → 支払い」2 tx が決済時 1 tx になり、レスポンスが HTTP サイクル内で
返る。タイムアウトは今より緩い。

**担保が要る 1 点 = リクエスト束縛**: omnibus の支払いは Buyer が出す具体的
リクエスト (method + URL + body hash) に束縛されていること。既存の
`requestBindingHash` (`method:url:bodyHash`) がそのまま担う。(2) 方式では agent が
リクエスト詳細を Subly に渡して束縛署名させる一手が要る。

### payer-of-record と user-of-the-API は別レイヤー

x402 の `exact` 支払いは**ステートレスな 1 リクエスト 1 解錠 (通行料)** であって、
アカウント/サブスク購入ではない。Seller 側に「顧客」「継続的権利」の概念がなく、
売るのは「この 1 リクエストへの 1 レスポンス」だけ。よって「**Subly が払う** =
Subly が顧客でアクセスを所有」ではなく「**Subly がその 1 リクエスト分の通行料を
精算しただけ**」。API を実際に使う (リクエストを決め、レスポンスを受け取り使う) のは
Buyer。ETC / コーポレートカード / 決済代行と同じで、支払い名義と利用者は別。
**ステートレス pay-per-call (PayAI / Nansen = Subly のコア対象) では権利が Subly に
張り付かず、素直に成立する。**

**例外 (payer-of-record が omnibus になる副作用)**:

1. **アカウント/APIキー発行型 Seller**: 「払う → payer identity に紐づくキーを発行 →
   N 回使える」型だと、キー/アカウントが omnibus に張り付く。Buyer に渡すには Subly が
   キーを預かり per-Buyer で仲介する一手が要る (純粋 pay-per-request では無関係)。
2. **payer 単位のレート制限 / 濫用検知**: 全 Buyer が同一 omnibus 1 アドレスから払う =
   Seller から見ると 1 wallet の超ヘビーユーザー。Seller の per-payer レート制限を共有し、
   濫用フラグに掛かるリスク。omnibus 共有の副作用として実運用で効く。対策 = 少数
   omnibus 分割 (§omnibus 単一 vs 少数のトレードオフと合わせて検討)。

## 決済フロー

```
[x402 決済の瞬間 — HTTP クリティカルパス]
  1. Buyer の agent が paid URL を叩く → 402 challenge
  2. relayer: mandate + yield-only guard で「このBuyerの claim可能 yield >= amount」を検証
     (超過なら拒否 = §与信にしない)
  3. omnibus(既存 float) → Seller  TransferChecked  amount   ← オンチェーンはこれ1本
  4. TEE ledger: Buyer X の balance を -amount で更新 + attestation
     (Buyer 資金はオンチェーンで動かない)

[別途・非同期 — float 補充]
  5. float が閾値を割ったら、複数 Buyer の Kamino position から
     batch realize → omnibus 補充 (額・時刻を Seller 決済と decouple)
```

決済時に Seller への出金へ時刻一致する Buyer 入金が無い ⇒ タイミング相関の
手がかりが消える。補充は多数 Buyer を混ぜた periodic top-up で、どの Seller
決済とも 1:1 対応しない。

## yield との両立 (「Subly じゃなくなる」への回答)

- **Buyer の principal は Kamino で回り続ける**。batch 補充の瞬間だけ動く。
  Buyer の利回りは守られる。決済ごとに元本を動かさない。
- **float は全 Buyer 共有・極小**。例: omnibus float $100 で数千件のマイクロ
  決済を捌ける。$100 の年間利回りロス ≈ $8 (Subly 全体) = 無視可。しかもこれは
  Subly の運転資本 (treasury) で持てばよく、per-user の遊休はほぼゼロ。
- 前回却下した stealth wallet 案 (per-user 遊休 float) と違い、**1 者が小さな
  float で全員分を立て替え、裏で batch 精算する**ので yield-just-in-time が崩れない。

## 相関攻撃と対策

| 相関手がかり | naive 実装での漏洩 | 対策 |
|---|---|---|
| **タイミング** | 「Buyer→omnibus $X」直後に「omnibus→Seller $X」だと即相関 | 決済は float から即払い、Buyer 入金を発生させない。補充は閾値駆動の batch で decouple (Core Decision 2) |
| **金額** | 補充 redeem 額が Seller 価格を鏡写しにすると対応がつく | **出金 (omnibus→Seller) = Seller 価格 (公開で可、"誰が"は明かさない)**。**入金 (float 補充) = $50 単位等の decouple した batch 増分**で、単一 Seller 価格を鏡写しにしない |
| **集計** | 「Buyer X が月に redeem した総額」対「Seller Y が月に受けた総額」の突合 | many-to-many でペアリング手がかりなし。マイクロ額が共通値 ($0.001/0.01/0.1) に集中し逆算困難。完全にはゼロにできない (§残存リスク) |

## 残存リスクと正直な限界

1. **統計的集計相関はゼロにならない**。上表の通り実務的逆算は困難だが理論上は残る。
2. **anonymity set = 同時利用者数**。初期・低トラフィックは弱い。深夜に 1 人だけが
   希少額を希少 Seller に払えば相関され得る。**利用者が増えるほど強くなる**性質。
3. **custody / commingling**。float で立て替える = Subly が一時的に Buyer の請求権を
   持つ。money-transmission / stored-value 規制の姿勢が濃くなる。**spending-mandate
   (owner 署名の上限) + kill-switch + per-user 台帳 attestation が load-bearing**
   になる (spending-mandate-design.md)。
4. **保護範囲**: 第三者オンチェーン観測者のみ。Subly 運営は全部見える (要件上 OK)。
   Seller は HTTP 層で Buyer を見得る (Non-goals)。

## Ledger と TEE

- **Ledger = 真実の残高の source of truth** (オフチェーン)。per-Buyer の
  claim 可能 yield / 使用済み / omnibus 立て替え残を持つ。
- **TEE 用途**: (a) ledger 更新の正当性を attestation で証明 (「改ざんしていない」を
  per-buyer データ非公開のまま検証可能に)、(b) selective disclosure (特定 Buyer /
  監査人にだけ開示)。custody/信頼のコストを相殺する層。
- **接続先**: spending-mandate の owner 署名 mandate / approval と、technical-design
  の relayer attestation。regulatory ナラティブは「yield-only (数学的上限) × 委任署名
  × 閾値 HITL × kill switch」に「**PSP omnibus + TEE-attested ledger**」が加わる形。
- 前例: Circle Gateway Nanopayments (prefunded balance の spend-down)。

## 実装で詰めるべき点 (次フェーズ)

1. **float sizing と batch realize 閾値**: omnibus 残高の下限/上限、補充 1 回の
   額の刻み (Seller 価格を鏡写しにしない decouple した増分)、補充頻度の
   タイミング decorrelation。
2. **realize-delegate / lien の具体**: Buyer の self-custody Kamino position に対し、
   立て替え分を確実に取り立てられる権限をどう担保するか。既存 signer policy /
   spending mandate との接続。
3. **yield-only guard の再利用**: 「既発生・claim 可能 yield 上限」= 立て替え上限の
   強制点を既存 guard で兼ねる実装。
4. **TEE attestation ↔ selective disclosure の接続**: ledger 更新証明の形式、
   監査開示 API。
5. **omnibus 単一 vs 少数**: anonymity set 最大化のため単一が原則。運用上の
   分割が要る場合のトレードオフ。
6. **x402 verifier 互換テスト**: source = omnibus での PayAI 等 exact verifier
   通過確認 (命令列不変の実証)。

## Seller にも隠す場合 (別スコープ)

本設計は第三者秘匿まで。Seller に対する Buyer 秘匿が要件になったら、HTTP 層の
Buyer 識別子最小化 (`wallet-auth-headers.ts`) が別途必要。運営 (Subly) にも
隠すなら mixer 必須で、これはコア非対応 = 大口オプトイン別モードのみ。

## Sources

- x402 facilitator / exact scheme: https://docs.x402.org/core-concepts/facilitator
- x402 whitepaper: https://www.x402.org/x402-whitepaper.pdf
- Umbra SDK (allowlist, fee): https://sdk.umbraprivacy.com/
- Privacy Cash fees: https://privacycash.mintlify.app/
- Solana Confidential Transfer: https://solana.com/docs/tokens/extensions/confidential-transfer
- Circle Arc Privacy: https://crypto.news/circle-unveils-arc-privacy-to-bring-confidential-smart-contracts-to-institutions/
- 却下記録詳細: memory `subly-x402-privacy-investigation`
- 関連: technical-design.md (yield-only guard / settlement) / spending-mandate-design.md (mandate / kill switch / selective disclosure)
