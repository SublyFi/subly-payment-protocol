# Agent Wallet Providers — 対応状況と追加実装の設計

作成: 2026-07-06 JST / Status: **記録 + 設計のみ(Turnkey 以降は実装未着手)**。
実装済み部分の検証手順は `docs/custody-wallet-smoke-test.md`、実装の入口は
`src/client/signer-env.ts`。

> 背景: Subly のエージェントウォレットは「秘密鍵をエクスポートできる
> ローカル鍵」に加え、カストディ/MPC 型のエージェントウォレットを
> `RemoteSignerTransport`(4 メンバーの薄い境界)で受ける構造にした。
> 2026-07 時点の Solana エージェントウォレット市場は Turnkey / Privy /
> Coinbase CDP / Crossmint の 4 社+αに収斂しており、中身はいずれも
> 「MPC/TEE 保持の ed25519 EOA + REST 署名 API + ポリシーエンジン」。
> つまり**この土俵の製品はすべて同じパターンで追加できる**。

## 1. 対応状況マトリクス(2026-07-06)

| プロバイダ | 中身 | 状態 | 備考 |
|---|---|---|---|
| local keypair | 自前 ed25519 | ✅ 実装済み | デフォルト。自ホスト TEE 運用も実質これ |
| Privy server wallets(agentic/owner-key 含む) | MPC EOA + authorization key | ✅ 実装済み | `privy-authorization-signature`(RFC8785→SHA-256→P-256 DER)対応済み。ユニットテストで実鍵検証 |
| Circle developer-controlled wallets | MPC EOA | ✅ 実装済み | Circle のエージェント向け Solana 正規ルート |
| **Turnkey** | Nitro Enclave 内 ed25519 + policy engine | 📝 本書 §3 設計済み | **次の本命**。SendAI Solana Agent Kit の標準署名レイヤー |
| **Coinbase CDP / Agentic Wallets** | Server Wallet v2(MPC + Nitro)+ policy | 📝 本書 §4 設計済み | AgentKit + x402 ネイティブ。2026-02 ローンチ |
| Crossmint agent wallets | フルスタック(signer は Turnkey/Privy 等をプラグ) | 📝 本書 §5 設計済み(構成分岐あり) | EOA 型 signer 構成なら載る。smart wallet 構成は要注意 |
| Dfns | MPC カストディ + User Action Signing | 📝 本書 §6 設計済み | 機関向け。認証が 2 段(challenge-response) |
| Fireblocks | MPC カストディ(RAW signing) | 📝 本書 §7 設計済み | 機関向け。非同期署名(ポーリング)+ RAW 署名の事前有効化が必要 |
| Para(旧 Capsule) | MPC 2/2(SDK 主体) | 📝 本書 §8 設計済み(要調査多) | REST が薄く SDK 依存になる見込み |
| Squads Grid / Smart Account | スマートアカウント(プログラム) | ❌ 対象外 | ウォレットアドレスが署名鍵でない。relayer の wallet-auth とオンチェーン署名の両方の仕様変更が必要 → §9 |
| Circle CLI「agent wallet」 | **EVM SCA(Base 等)** | ❌ 原理的に不可 | Solana に存在せず ed25519 鍵も署名 API もない。どんな実装でも不可 |
| ブラウザウォレット(Phantom 等) | 対話型 | 対象外 | 非対話エージェント運用と不整合(鍵エクスポートすれば local で可) |

フレームワーク(SendAI Solana Agent Kit / ElizaOS / Coinbase AgentKit)は
ウォレットではなく統合層で、裏の署名者が上記のどれか。**Turnkey + CDP を
足すとフレームワーク経由の実質カバレッジがほぼ 100% になる**。

## 2. 共通パターン — プロバイダ追加の標準手順

新プロバイダ 1 社の追加 = 以下の 5 点セット(Privy/Circle が参照実装)。
検証境界(intent 検証 → 署名依頼 → 返却署名を自前バイト列+公開鍵で検証)
には一切手を入れないこと。

1. **transport 1 ファイル** `src/client/signer-transports/<provider>.ts`
   - 実装は `RemoteSignerTransport` の 4 メンバーのみ:
     `provider` / `walletAddress` / `signMessage(bytes)→64byte 署名` /
     `signTransaction(base64)→署名済み wire tx base64`
   - 共有ヘルパーを使う: `providerJsonRequest`(HTTP+エラー整形)、
     `verifiedEd25519Signature`(エンコーディング正規化。**全候補が
     ed25519 検証でゲートされるので誤受理は構造的に不可能**)、
     `RemoteSigningError`
   - factory 起動時にウォレットを GET してアドレスを pin +
     **チェーン厳格チェック**(mainnet Solana 以外は設定時点で fail)
2. **env 分岐 1 つ** `src/client/signer-env.ts`(判別可能ユニオンに 1 腕追加。
   credential は `requireVar`/`pickVar` 経由 = SUBLY\_ プレフィックス上書き対応)
3. **スタブ E2E テスト** `tests/<provider>-transport.test.ts`
   (`fetchImpl` 注入でリクエスト認証・署名検証まで実鍵で回す。
   `tests/privy-transport.test.ts` が雛形)
4. **ドキュメント**: `packages/pay/README.md` の env 表 +
   `docs/custody-wallet-smoke-test.md` に Part 追加(3 つの未知数の
   フレームは全プロバイダ共通: ①非 fee-payer 署名 ②生バイト message
   署名 ③複雑 tx 許容)
5. **実クレデンシャル smoke test**(手順書どおり。~1.02 USDC / SOL 不要)

規模感: 1 プロバイダ = transport ~150 行 + テスト ~150 行 + doc。半日 + smoke。

## 3. Turnkey 設計(優先度 1)

採用理由: Solana Agent Kit v2 の標準署名レイヤーで Solana エージェントでの
採用実績が最も厚い。policy engine(tx 上限、アドレス allowlist、承認フロー)
が spending mandate と二重の安全網になる。

- **認証**: API リクエストごとに **X-Stamp ヘッダ**。
  `{publicKey, scheme: "SIGNATURE_SCHEME_TK_API_P256", signature}` を
  base64url した「stamp」で、signature は **リクエスト body の JSON 文字列
  そのものへの ECDSA P-256 署名**(Privy の RFC8785 正規化と違い、
  送った body のバイト列に対して署名 — 送信 body と署名対象を同一文字列に
  すること)。API キーは Turnkey dashboard で発行する P-256 ペア。
- **署名 API**(activity 形式。POST /public/v1/submit/...):
  - message 署名: `ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2` —
    `signWith`(ウォレットアドレス可)、`payload`(hex)、
    `encoding: PAYLOAD_ENCODING_HEXADECIMAL`、
    `hashFunction: HASH_FUNCTION_NOT_APPLICABLE`(ed25519 は生バイト署名)。
    → 未知数②のリスクが構造的に低い(生バイト署名が仕様で明示できる)
  - tx 署名: `ACTIVITY_TYPE_SIGN_TRANSACTION_V2` —
    `type: TRANSACTION_TYPE_SOLANA`、`unsignedTransaction`(hex)。
    → signedTransaction が返る
  - レスポンスは activity envelope(`activity.result....`)。非同期
    (consensus 待ち)になり得る点に注意: ポリシーで即時承認になる構成のみ
    サポートし、`ACTIVITY_STATUS_COMPLETED` 以外は typed error で fail。
- **env 案**: `SUBLY_SIGNER_PROVIDER=turnkey` +
  `TURNKEY_API_PUBLIC_KEY` / `TURNKEY_API_PRIVATE_KEY`(P-256 hex)/
  `TURNKEY_ORGANIZATION_ID` / `TURNKEY_SIGN_WITH`(Solana アドレス)。
  wire の signerProvider は `"turnkey"`。
- **実装前の要確認**(上記は 2026-01 時点の知識ベース。着手時に必ず
  <https://docs.turnkey.com> の API リファレンスで確認):
  - [ ] stamp の正確なフィールド名と base64url 形式
  - [ ] SIGN_RAW_PAYLOAD / SIGN_TRANSACTION の最新 activity type バージョン
  - [ ] Solana signTransaction の入出力エンコーディング(hex か base64 か)
  - [ ] signWith にアドレスを渡せるか(private key id が必要か)

## 4. Coinbase CDP / Agentic Wallets 設計(優先度 2)

採用理由: Agentic Wallets(2026-02)は AgentKit + x402 前提でストーリー
相性が最良。中身は CDP Server Wallet v2 の Solana アカウント(EOA)。

- **認証(2 層)**:
  1. Bearer JWT — CDP API キー(Ed25519 or ES256)で署名。claims に
     メソッド+ホスト+パスの `uris` を含む短命 JWT(~2 分)
  2. `X-Wallet-Auth` JWT — **Wallet Secret** で署名する account 操作用の
     追加 JWT(sign 系エンドポイントで必須)
  - JWT 生成は自前実装だと重いので、**公式 `@coinbase/cdp-sdk` を
    devDependency ではなく optional peer にして dynamic import する案**と、
    JWT 2 種を自前生成する案の 2 択。transport の外部依存を増やさない
    方針なら自前生成(node:crypto で可能)だが、claims 仕様の変更リスクを
    負う。着手時に判断。
- **署名 API**: `POST /platform/v2/solana/accounts/{address}/sign-message`
  と `/sign-transaction`(base64 tx → signedTransaction base64)。
- **env 案**: `SUBLY_SIGNER_PROVIDER=coinbase` +
  `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` / `CDP_WALLET_SECRET` /
  `CDP_SOLANA_ADDRESS`。wire の signerProvider は `"coinbase-cdp"`。
- **実装前の要確認**:
  - [ ] JWT claims の正確な仕様(`uris` 形式、有効期限、nonce)
  - [ ] X-Wallet-Auth の payload(リクエストハッシュを含むか)
  - [ ] sign-message が生バイト署名か(未知数②)
  - [ ] Agentic Wallet のポリシーエンジンが非 fee-payer tx を通すか(未知数①)
  - [ ] sandbox/mainnet の切り替えとレート制限

## 5. Crossmint 設計(優先度 3・構成分岐あり)

採用理由: フルスタック(決済・オンランプ・コンプラ込み)でエージェント
開発者の入口になりやすい。ただし **Solana の Crossmint ウォレットには
2 構成があり、載るのは片方だけ**:

- **構成 A: カストディ/MPC ウォレット(server-side admin signer)** —
  ed25519 EOA。transport パターンで対応可能。**これが対応対象**。
- **構成 B: Solana embedded smart wallet(プログラム型 + delegated
  signers)** — Squads と同じ「アドレス ≠ 署名鍵」問題で対象外(§9)。
  ただし delegated signer として登録された agent keypair をユーザーが
  Subly の local provider に直接渡す運用は可能(Crossmint API を経由しない)。

- **認証**: サーバー API キー(`X-API-KEY` ヘッダ)。scope は wallets 系。
- **署名 API**(wallets API `2022-06-09`):
  - message 署名: `POST /api/2022-06-09/wallets/{walletLocator}/signatures`
    — Solana は message 型シグネチャをサポート(Create Signature
    エンドポイント)。作成 → (自動)approve → GET で署名取得、の
    **非同期 2 段**になる可能性が高い(custodial は自動 approve)。
  - tx 署名: `POST .../transactions` に**外部構築 tx(base64)を渡せるか
    が最大の要確認点**。Crossmint が tx を構築する approve フロー専用
    だと、Subly の「準備済みバイト列に署名」モデルに合わない。
- **env 案**: `SUBLY_SIGNER_PROVIDER=crossmint` +
  `CROSSMINT_API_KEY` / `CROSSMINT_WALLET_LOCATOR`。wire は `"crossmint"`。
- **実装前の要確認**:
  - [ ] Solana カストディウォレット(EOA)を API で作れるか、それとも
        smart wallet のみか(EOA 不可なら対応自体を見送り、構成 B の
        delegated-signer 運用を README で案内する)
  - [ ] signatures エンドポイントの Solana message パラメータ形式と
        署名の返却エンコーディング
  - [ ] 外部構築 tx への署名可否(上記)
  - [ ] 署名完了までのポーリング要否とレイテンシ

## 6. Dfns 設計(優先度 4・機関向け)

- **認証(2 段)**: ①service account の Bearer token、②**User Action
  Signing** — すべての変更系 API は
  `POST /auth/action/init` で challenge を取得 → **Key credential
  (P-256/EdDSA 鍵)で challenge に署名** → `POST /auth/action` で
  signing token を得て `X-DFNS-USERACTION` ヘッダに載せる、という
  challenge-response が **リクエストごと**に必要。transport 内に
  この 3 往復をカプセル化する(署名 1 回 = HTTP 4 往復になる点は
  レイテンシ注意)。
- **署名 API**: `POST /wallets/{walletId}/signatures`
  (`wallets.generateSignature`)。Solana は `kind: "Transaction"` で
  unsigned tx を受ける — **Dfns は placeholder(0 埋め)署名スロット付きの
  serialized tx を期待する**と明記されており、Subly の prepare 済み tx は
  この形なのでそのまま渡せる見込み。message 署名は `kind: "Message"`
  (生バイト hex)。レスポンスは signature オブジェクト(r/s ではなく
  ed25519 の 64 バイトが返るか要確認)。
- **env 案**: `SUBLY_SIGNER_PROVIDER=dfns` + `DFNS_API_TOKEN` /
  `DFNS_CREDENTIAL_ID` / `DFNS_CREDENTIAL_PRIVATE_KEY`(User Action 用)/
  `DFNS_WALLET_ID`。wire は `"dfns"`。
- **実装前の要確認**:
  - [ ] User Action Signing の challenge 署名ペイロード形式
        (clientData 構造・base64url)
  - [ ] Solana `generateSignature` のレスポンスから 64 バイト署名を
        取り出す形式(signed tx が返るか signature 単体か)
  - [ ] `kind: "Message"` が Solana ウォレットで生バイト ed25519 になるか
        (未知数②)
  - [ ] service account のポリシー(Policy Engine)が非 fee-payer tx を
        通すか(未知数①)

## 7. Fireblocks 設計(優先度 4・機関向け)

- **認証**: API キー + **リクエストごとの JWT**(RSA 秘密鍵で署名。claims
  に uri・nonce・**body の SHA-256 ハッシュ**を含む)。`X-API-Key` +
  `Authorization: Bearer <jwt>`。
- **署名 API**: Fireblocks は「トランザクション」として署名要求を作る
  **非同期モデル**:
  - `POST /v1/transactions` で `operation: "RAW"`, `assetId: "SOL"`,
    `extraParameters.rawMessageData.messages[].content = <hex>`
    (message 署名・tx messageBytes 署名の両方ともこの RAW 経路)
  - → `GET /v1/transactions/{txId}` を **COMPLETED までポーリング** →
    `signedMessages[].signature`(ed25519)を取得
  - transport 内にポーリング(上限付き backoff)をカプセル化。
    Fireblocks の Transaction Authorization Policy(TAP)が承認待ちに
    すると数秒〜無期限になり得るので、タイムアウトを typed error で返す。
- **重要な前提**: **RAW signing は既定で無効**。Fireblocks サポートに
  依頼してワークスペースで有効化してもらう必要がある(機関契約前提)。
  RAW を使うため、tx として渡すのではなく messageBytes への署名になる —
  Subly 側は `signTransaction` も「messageBytes に RAW 署名 → 自前で
  attach」で成立する(検証境界はそのまま)。ただし transport の
  `signTransaction` 契約は「署名済み wire tx を返す」なので、Fireblocks
  transport は**内部で署名を自前 tx に attach してから返す**実装になる
  (`attachExternalSignatureToTransaction` を transport 側で利用)。
- **env 案**: `SUBLY_SIGNER_PROVIDER=fireblocks` + `FIREBLOCKS_API_KEY` /
  `FIREBLOCKS_SECRET_KEY_PATH`(RSA PEM)/ `FIREBLOCKS_VAULT_ACCOUNT_ID`。
  wire は `"fireblocks"`。
- **実装前の要確認**:
  - [ ] JWT claims の正確な仕様(uri, nonce, bodyHash, exp 55 秒制限)
  - [ ] RAW signing の Solana(ed25519)対応形式と signature 返却形式
  - [ ] TAP と非 fee-payer tx(未知数①相当は TAP 設定次第)
  - [ ] ポーリング間隔・レート制限

## 8. Para(旧 Capsule)設計(優先度 5・要調査多)

- **モデル**: MPC 2/2(ユーザーシェア + Para シェア)。サーバー側は
  `@getpara/server-sdk` で **session を import して署名**する SDK 主体の
  設計で、**素の REST 署名 API が公開されているかが未確認**。
  Subly transport は「依存を増やさない生 REST」を基本方針にしてきたが、
  Para は SDK の dynamic import(provider=para のときだけ import)に
  なる見込み — この方針転換を許容するかが最初の判断点。
- **署名**: SDK の Solana アダプタ(`@getpara/solana-web3.js-*`)経由で
  signMessage / signTransaction。pregenerated wallets(エージェント用に
  サーバーで事前生成)なら session 管理が単純になる。
- **env 案**: `SUBLY_SIGNER_PROVIDER=para` + `PARA_API_KEY` /
  `PARA_SESSION`(または pregen wallet の識別子)。wire は `"para"`。
- **実装前の要確認**:
  - [ ] REST 直叩きの署名 API の有無(あれば SDK 不要で他と同型にできる)
  - [ ] session の寿命・更新(非対話エージェントで維持できるか)
  - [ ] pregenerated wallet の生バイト message 署名可否(未知数②)

## 9. Squads(スマートアカウント)を将来やる場合の論点(対象外の記録)

現行の前提「ウォレットアドレス = ed25519 署名鍵」が崩れるため、
transport 追加では対応できない。必要になるのは:
1. relayer の wallet-auth を「スマートアカウント + 署名メンバー鍵」の
   2 段検証に拡張(`x-subly-wallet` ≠ 署名者)
2. vault ポジション所有者・tx 署名者をスマートアカウントの
   authority 構造に合わせて分離
3. x402 支払いレグ(@x402/svm)は EOA 署名前提のため、facilitator 側の
   対応も必要 — Subly 単独では閉じない
需要(DAO treasury をエージェント資金源にする等)が出るまで凍結。
Crossmint の smart wallet 構成(§5 構成 B)も同じ理由でここに入る。

## 10. 優先順位まとめ

| 順 | プロバイダ | 根拠 | 主リスク |
|---|---|---|---|
| 1 | Turnkey | Solana Agent Kit 標準・採用最多 | activity 非同期(consensus 構成) |
| 2 | Coinbase CDP | Agentic Wallets + x402 文脈 | JWT 2 層の仕様追随 |
| 3 | Crossmint | フルスタック入口 | EOA 構成の有無(不可なら見送り) |
| 4 | Dfns / Fireblocks | 機関需要が出たら | 認証多段・非同期署名・契約前提 |
| 5 | Para | 需要次第 | REST 不在なら SDK 依存の方針転換 |

## 11. 記録 — ここまでの経緯

- 2026-07-05: local/circle/privy の 3 プロバイダ実装、8 観点レビュー →
  全指摘修正(詳細は git log と memory)。Circle CLI agent wallet が
  EVM SCA で原理的に不可と確定。
- 2026-07-05(同日後半): Privy authorization key(agentic wallets)対応。
  実 P-256 鍵でヘッダ署名を検証するユニットテスト付き。
- 2026-07-06: 本書作成。Turnkey / CDP / Crossmint / Dfns / Fireblocks /
  Para の 6 プロバイダ分の transport 設計を記録(いずれも実装未着手。
  各節の「実装前の要確認」チェックリストを潰してから着手すること)。
- smoke test は全プロバイダ未実施(手順: `docs/custody-wallet-smoke-test.md`)。

参考資料: [Crossmint Create Signature](https://docs.crossmint.com/api-reference/wallets/create-signature),
[Crossmint Solana Embedded Smart Wallets](https://blog.crossmint.com/solana-embedded-smart-wallets/),
[Dfns Solana Generate Signature](https://docs.dfns.co/api-reference/sign/solana),
[Dfns User Action Signing](https://docs.dfns.co/d/api-docs/authentication/user-action-signing),
[Turnkey Docs](https://docs.turnkey.com), [Coinbase Agentic Wallets](https://www.coinbase.com/developer-platform/discover/launches/agentic-wallets),
[Agent Wallets Compared (Crossmint)](https://www.crossmint.com/learn/agent-wallets-compared)
