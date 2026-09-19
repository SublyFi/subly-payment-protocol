# Sublyをはじめる

Sublyは、SolanaのKamino USDC vault（USDCの運用先）から得た利回りで、AIが対応する有料APIへ支払うためのOSSです。**0.8.1はベータ版**で、外部セキュリティ監査は受けていません。実際の入出金にはmainnetの実資金を使い、元本や利回りが保証されるものではありません。

まず、どこまで自分で用意するかを選んでください。

| やりたいこと | 進み方 | 得られるもの |
| --- | --- | --- |
| 運用者のrelayerを使ってAIやCLIから利用する | 下の「利用者として始める」→ [AIへの依頼文 A](ai-setup-prompts.md#a-既存relayerを使う人向け) | 手元のクライアント設定、接続確認、owner setupの準備 |
| 自分のサーバーでrelayerを運用する | 下の「relayerを運用する」→ [AIへの依頼文 B](ai-setup-prompts.md#b-自分のrelayerを運用する人向け) | 自分のURLで動くrelayer、DB、HTTPS、運用準備 |
| 資金を使わずAPIを触ってみる | [ローカル開発](../README.md#try-it-locally) | detached APIの動作確認。入出金・支払いはできません |
| 実装に参加する | [開発ガイド](../CONTRIBUTING.md) | 開発環境とテスト手順 |

公開元は [SublyFi/subly-payment-protocol](https://github.com/SublyFi/subly-payment-protocol)、クライアントは `@subly_fi/pay@0.8.1`、対応するソースタグは `pay-v0.8.1` です。詳しいコマンドと設定の正本は[クライアントガイド](../packages/pay/README.md)と[運用者ガイド](../deploy/README.md)です。

## 利用者として始める

初めは、必要なものが「ある／ない」だけ確認すれば構いません。

| 用意するもの | 確認すること |
| --- | --- |
| Node.js 24以上を使えるPC | macOS、Windows、Linuxそれぞれの起動方法に合わせます |
| 信頼するrelayerのHTTPS URL | 自分で選んだ運用者から受け取ります。Sublyのアカウント登録は不要です。常設の無料公開relayerがあるとは限りません |
| 専用のagent wallet | Solanaキーペア、Circle、Privyに対応。Sublyが自動で作成・資金補充するわけではありません |
| mainnet RPCの設定 | 署名前の取引検証に必要です。simulationとinner instructionsに対応するものを使います |
| 確認済みのvault情報 | 運用者の情報とローカル設定が一致する必要があります。複数候補があれば自分で選びます |
| ownerのpasskeyまたは別のwallet | 支出条件の確認・承認を本人が行います |
| MCP対応ホスト、またはCLI | アプリがローカルstdio MCPを起動できるか確認します。接続ツールのないChatGPTのチャット画面だけでは使えません |

**秘密鍵・シード・APIキーはAIとのチャットに貼らないでください。** RPC URLにもキーが含まれることがあります。AIへ渡すのはファイルの場所や設定済みかどうかで、秘密そのものは手元で入力します。[依頼文 A](ai-setup-prompts.md#a-既存relayerを使う人向け)を使うと、不足する情報から順に確認できます。端末を操作できないAIは手順案内にとどまります。

新しくキーを作る場合も、AIが出力を収集しない本人の端末を使います。`solana-keygen new`は既定で復元用シードを表示するので、画面や実行結果をチャットへ貼らないでください。

利用までの流れは次のとおりです。

1. **設定して接続を確認する。** 版を0.8.1に固定し、まず `doctor`、vault一覧、MCPならツール一覧を確認します。CLIとMCPのwallet・vault・relayer・pendingファイルの場所を揃えます。設定場所やJSON形式はアプリごとに異なります。
2. **自分の支出条件を登録する。** vault、入金額、上限、承認条件、有効期間を決めてsetupリンクを作ります。正しい運用者のドメインで内容を確認し、自分のpasskeyかowner walletで承認します。その後チャットに戻ってAIへ完了を伝え、`check_subly_setup`で確認してもらいます。CLIなら `npx -y @subly_fi/pay@0.8.1 setup-status <sessionId>` で確認します。AIへの依頼だけで本人の承認が済むわけではありません。
3. **許可した金額を入金する。** mainnet USDCを用意し、入金先と金額を確認してdepositします。初回setupに入金承認を含めても、実際のdepositは別の操作です。例の金額は推奨額ではありません。`1000000` raw USDCが1 USDCです。
4. **使える利回りが貯まるのを待つ。** 入金直後に支払い予算ができるとは限りません。`budget`で、価格と手数料をまかなうspendable yieldがあるか確認します。繰り返し実行しても利回りは増えません。
5. **対応するAPIへ支払う。** 対象はSolana mainnet USDCの`exact`と`extra.feePayer`を提供するx402 APIです。任意のURLや他チェーンの有料APIには支払えません。既定上限は1回0.01 USDCですが、ownerの設定がさらに厳しい場合があります。
6. **必要なときに出金する。** withdrawは元本を含む資金を同じagent walletへ戻す操作です。流動性、手数料、ownerの承認条件によって制限されます。

「設定完了」と「実資金での利用完了」は別です。MCP接続や `doctor` の成功は、入出金・支払いの成功やvaultの安全性を証明しません。

## 承認と保管について

Agent walletは取引に署名する財布、ownerは利用条件を承認する人です。passkeyは各支払いに付く追加のオンチェーン署名ではなく、relayerが守る支出条件を承認します。agentの鍵を持つ者がSublyの外で取引することまで防ぐものではありません。専用walletと信頼する運用者を使ってください。

最初のsetupを完了した人が、そのwallet/vaultのownerになります。setup・approveリンクは公開しないでください。setupリンクは10分で失効し、初回入金の承認も短時間で失効します。期限切れなら現在の手順で再確認します。

Passkeyは運用者のドメインに紐づきます。端末やドメインが変わっても必ずすぐ使えるわけではありません。有効な既存条件の変更には同じownerによる承認が必要で、復旧には制約や72時間の猶予があります。revokeはrelayer経由の出金も止め、既に送信済みの取引は取り消せません。期限切れのmandateは既定ポリシーへ戻るため、資金のオンチェーン凍結とは異なります。詳しくは[セキュリティモデル](security-model.md)を確認してください。

現在のCLI/MCPには、既存passkeyの支出条件変更、revokeの解除、復旧を完結する専用操作がありません。初回setupをやり直せば解決するとは限りません。これらが必要な場合は運用者に相談し、対応状況を確認してください。

Vaultの選択を変えても、資金は移動しません。承認条件・元本・利回りはwalletとvaultの組ごとに別です。以前のvaultから出金するときは元のvaultを選びます。

## 途中で止まったら

`submitted` は失敗の確定ではありません。確認待ちの入出金をもう一度実行すると、別の取引になり得ます。

| 表示・状況 | 次にすること |
| --- | --- |
| deposit / withdrawが確認待ち | 元の `dep_...` / `wdr_...` IDを残し、同じwallet・vault・relayerで `npx -y @subly_fi/pay@0.8.1 status <intentId>` またはMCPの `check_subly_vault_operation` を使います。relayer 0.8.0以上では元の取引を再送せず照合します |
| 支払いの利回り取り出し中に中断 | pending JSONを保存したまま、[復旧手順](../packages/pay/README.md#recovery-and-troubleshooting)で元の操作を再開・照合します |
| 外部APIへの支払い結果が不明 | 二度目の支払いをせず、売り手・facilitator・運用者と元の結果を確認します |
| `insufficient_yield` | 支出可能な利回りを確認し、待ちます。元本を支払い予算へ付け替えません |

Pendingファイルの削除、別ファイルへの切り替え、強制的な再支払いで回避しないでください。利回りの取り出しとAPI支払いは別々の取引なので、APIが失敗してもUSDCがwalletに残る場合があります。[トラブルシューティング](troubleshooting.md)に沿って確認します。

## Relayerを運用する

利用者としての設定に加えて、サーバー運用が必要です。relayerはvault取引のガス代を負担し、PostgreSQLに元本と利回りの帳簿を保存します。売り手のx402 facilitatorとは別の役割です。

必要なのは、Docker Composeを使えるホスト、自分のドメインとHTTPS、専用mainnet RPC、Pyth価格取得の設定、SOLを使うsponsor wallet、永続DBとバックアップです。[依頼文 B](ai-setup-prompts.md#b-自分のrelayerを運用する人向け)で、まず新規構築か既存環境の更新かを伝えてください。

AIと進める順番は、環境確認、タグ付きソースと秘密ファイルの配置、vaultカタログの確認、HTTPSとDBの起動、読み取り検証、バックアップと監視の準備です。詳しい手順は[運用者ガイド](../deploy/README.md)にまとめています。既存DBや設定は初期化せず、資金が残るvaultをカタログから消さないでください。

資金補充、LUT作成、invest、実資金の入出金や有料API試験は、対象・金額や費用を確認してから行います。すべてのvaultに追加LUTが必要とは限りません。gasや口座作成費は運用費です。現在のfee debtは支払い予算の調整であり、運用者への返金・収益回収機能ではありません。

`healthz` / `readyz`の成功、読み取り検証、ローカルfork、実資金mainnetの検証は確認範囲が違います。[検証状況](validation.md)を参照し、自分の環境で実施していないことを「検証済み」と案内しないでください。

困ったときは秘密を除いた版、エラーコード、止まった段階を残して[サポート窓口](../SUPPORT.md)へ。セキュリティ上の問題は[非公開の報告手順](../SECURITY.md)を使ってください。
