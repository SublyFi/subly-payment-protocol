# AIにセットアップを依頼する / AI setup prompts

対象は **Subly 0.8.1** です。[日本語ガイド](getting-started.ja.md)で進み方を選び、下の依頼文を丸ごとClaude Code、Codex、ChatGPTなどへ貼ってください。［未定］はそのままでも構いません。詳しい設定の正本は[クライアントガイド](../packages/pay/README.md)と[運用者ガイド](../deploy/README.md)です。

秘密鍵・シード・APIキー・トークン・環境ファイルの中身は貼らないでください。キーを含むRPC URLも秘密です。共有するのは設定ファイルの場所や「設定済み／未設定」だけにします。

- **既存relayerを使う人**は A。運用者からHTTPS URLと確認済みのvault情報を受け取ります。
- **サーバーを運用する人**は B。クライアント設定だけではrelayerは立ち上がりません。
- 実行ツールのあるAIは手元の設定・検証を進められます。端末やMCPに接続していないChatGPT等は手順案内になります。AIへの課金と、ローカルMCPを接続できることは別です。

この依頼文だけで実資金操作を許可することにはなりません。金額・対象を決めるのは利用者、passkey等で承認するのは本人です。

## A 既存relayerを使う人向け

```text
Subly 0.8.1を私のAIまたはCLIから使えるよう、初心者に分かる日本語でセットアップしてください。

分かっている情報（秘密は書かない）：
OS［未定］／MCPホスト名またはCLIのみ［未定］
信頼するrelayerのHTTPS URL［未定］
agent walletの種類とキーペアの絶対パス［未定］
RPCの設定ファイルの場所［未定］
確認済みvaultカタログの場所と選びたいvault［未定］

最初に実際のツールを確認してください。端末操作ができるAIならOS・既存設定を調べ、可逆的なローカル作業を進めてください。接続ツールのないChatGPT等なら、一手順と成功判定を示して私の結果を待ち、実行済みと装わないでください。不足する非秘密情報だけをまとめて質問してください。

1. https://github.com/SublyFi/subly-payment-protocol の公開タグ pay-v0.8.1 とnpmの @subly_fi/pay@0.8.1 を確認してください。そのタグの packages/pay/README.md、docs/security-model.md、docs/troubleshooting.md を読み、必要に応じて deploy/README.md と docs/agent-wallet-providers.md を参照します。コマンドを推測せず、未公開・未確認ならその旨を報告し、latest等へ勝手に切り替えないでください。relayerが未定なら常設の無料サービスがあると仮定しないでください。

2. 秘密鍵・シード・APIキー・秘密を含むRPC URL・設定全文をチャットに求めないでください。秘密はAIが記録しない本人の端末で入力します。秘密ファイルや環境変数一覧を出力せず、ログ・履歴・Gitにも残しません。solana-keygen newは既定で復元用シードを表示するため、キー生成はAIの実行ツールで行わず、本人の私的な端末で行い、その出力をチャットへ貼らせないでください。既存キーを上書きせず、安全な保管・バックアップも案内します。他のファイルとMCP設定も保存し、必要部分だけ更新します。秘密のあるバックアップも保護してください。

3. Node.js 24以上を用意し、実際のMCPホストの現在の公式設定方法を確認してください。汎用JSONやローカルstdio MCPが全アプリで使えると仮定せず、非対応なら対応ホストかCLIを案内します。OSに合うパス・起動方法を使い、デスクトップアプリへ端末の環境変数が届くかも確認してください。CLI/MCPのwallet・relayer・確認済みvaultと選択先・永続的なSUBLY_MCP_STATE_PATHを揃えます。既存の秘密変数がファイル指定より優先されていないか、値を出さず確認します。同じwalletに別のpendingファイルを作らず、別マシンとは排他できないことも説明してください。遠隔応答だけで署名の信頼設定を書き換えたり、APYでvaultを自動選択したりしないでください。

4. 読み取りチェックから始めます。version/help、doctor、vault一覧、MCPなら接続とツール一覧を検証してください。設定全文や認証ヘッダーは出力せず、利用状況の外部送信や分析サービスは追加しません。doctor成功は残高・利回り・vaultの安全性や実取引の成功を証明しません。

5. vault、初回入金額、支出上限、承認条件、有効期間を私と確認してowner setupを準備します。例の金額を無断で採用しないでください。setup/approveリンクは本人だけに渡し、公開ログへ残しません。私が正しいドメインでwallet・vault・条件を確認し、自分でpasskeyかowner walletを使います。AIは承認を代行しません。私がチャットへ戻って承認完了を伝えたら、check_subly_setupまたは版を固定したCLIのsetup-statusで確認し、許可済みのdepositへ進みます。最初にsetupを完了した人がownerとなり、passkeyはドメインに紐づきます。失効・revoke・復旧の制約を説明してください。現CLI/MCPには既存passkeyの条件変更・revoke解除・復旧を完結する専用操作がないため、架空のコマンドを作らず運用者への確認事項にします。

6. この依頼だけでは実資金操作は未許可です。walletへの資金補充、deposit、有料fetch、withdrawは、対象・通貨・金額（APIはURLと支払上限）を私が明示的に許可してから行います。既に許可した同じ操作を何度も確認する必要はありません。1000000 raw USDC = 1 USDCです。入金直後は支払い予算がなく、手数料込みのspendable yieldを待つことがあります。任意のURLには支払えず、Solana mainnet USDC exactとextra.feePayer対応のx402 APIが必要です。未許可の有料呼び出しを動作確認に使わないでください。

7. submittedや結果不明では新しい同一操作を繰り返しません。通常の入出金は元のdep_/wdr_ IDを保管し、同じwallet・vault・relayerでstatus（対応版のresubmit=false）を調べます。fetchはpending JSONを保持し、realizationの回復と外部支払いの結果不明を区別して正本に従います。state削除、forceNewPayment、別wallet/vaultへの切り替え、元本帳簿変更、検証無効化で回避せず、必要なら運用者との照合待ちにしてください。

最後に「完了」「私の操作待ち」「未検証」を分け、実際の版、変更ファイルのパス、認証情報を除いた接続先、公開wallet、vault、pendingパス、通過したチェック、次の一手を報告してください。秘密や承認リンクを再掲せず、設定だけでmainnet入出金・支払い検証済みと報告しないでください。
```

## B 自分のrelayerを運用する人向け

```text
Subly 0.8.1のrelayerを自分で運用できるよう、公式手順に沿って日本語で構築を支援してください。設定・起動・読み取り検証・運用準備まで進めてください。

分かっている情報（秘密は書かない）：
新規構築か既存環境の更新か［未定］
操作PCとサーバーのOS、SSH接続先の別名［未定］
自分のドメイン、DNS状況、設置先ディレクトリ［未定］
Docker Composeの有無［未定］
RPC・Pyth設定とsponsorキーペアの保存場所［未定］
既存DB・バックアップの有無、提供したいvault［未定］

実際の端末・SSHツールと接続先を確認してください。実行できるAIなら読み取り・可逆的準備を進めます。接続ツールのないChatGPT等なら、一手順と成功判定を示して私の結果を待ち、実行済みと装わないでください。既存環境の停止等には具体的な変更・復旧案を用意して必要な確認をします。不足する非秘密情報だけを質問してください。

1. https://github.com/SublyFi/subly-payment-protocol の公開タグ pay-v0.8.1 とnpmの @subly_fi/pay@0.8.1 を確認してください。そのタグの deploy/README.md、packages/pay/README.md、docs/security-model.md、docs/validation.md、docs/troubleshooting.md と配布設定例を読みます。コマンドを推測せず、将来のmainや古い設計メモを混ぜません。未公開・未確認なら報告し、別版に勝手に切り替えないでください。

2. 秘密鍵・シード・SSH秘密鍵・APIキー・DBパスワード・認証付きRPC URL・.env全文をチャットに求めません。私がAIに記録されない端末からファイルへ入力し、値を表示せず存在と形式を検査します。秘密ファイルや環境変数一覧を出力せず、Git・イメージ・履歴・ログへ残しません。solana-keygen newは既定でシードを表示するため、キー生成はAIの実行ツールではなく本人の私的な端末で行い、出力をチャットへ貼らせないでください。既存キーを上書きせず、安全な保管・バックアップも案内します。監視webhookも秘密です。利用状況の外部送信や分析サービスを勝手に追加しないでください。

3. 新規と既存を分け、設定・DB・vault・pending記録を保存します。例示のcpやリダイレクトで既存ファイルを上書きしません。更新はDBバックアップ、復元手順、旧プロセス停止、移行の影響を確認して行い、旧新版を混在させません。DB初期化・元本リセットはしません。データ更新後にバイナリだけ戻せば安全とは扱わないでください。

4. 正本に沿ってNode.js 24以上、Docker Compose、専用mainnet RPC、Pyth価格取得、専用sponsor鍵、PostgreSQL、Caddy HTTPSを整えます。sponsorはagent walletと別です。秘密ファイルは必要な実行ユーザーだけが読めるようにします。自分のドメインでsetup/approve URLとWebAuthnを一致させ、SUBLY_MANDATE_ENFORCEMENT=onにします。admin tokenをクライアントへ渡さず、DBとrelayerポートは直接公開しません。プロキシ信頼は正本の構成に限ります。クラウド契約等の新たな支出は具体的な内容を先に確認してください。

5. 公式メタデータとチェーンを読み取り確認してvault候補を用意し、私が選びます。稼働中カタログを再生成結果だけで置き換えず、資金や未確定操作があるvaultを保持します。複数vaultなら対応Composeファイルを常に併用し、確認済み情報をクライアントにも配布します。秘密を展開表示しない設定検査後、HTTPS、healthz、readyz、vault一覧、DB保存先、バックアップ・復元、sponsor残高と監視の準備を確認します。read-only validate:mainnetは前提が揃う場合に実行し、不足するshares等は未検証と記録します。health成功は流動性や取引成功の保証ではありません。

6. この依頼だけでは実資金操作は未許可です。sponsor/agentへの資金補充、deposit、有料fetch、withdraw、LUT作成、investは、私が対象と金額または操作範囲・費用上限を明示的に許可してから行います。勝手に実資金の定期実行を追加しません。追加LUTは現在のwithdrawal経路で必要と確認できる場合だけ候補にし、古いatomic診断だけを理由に作りません。ownerは正しいドメインで自分で条件を確認・承認します。AIは代行しません。手数料込みのspendable yieldには待ち時間があり、帳簿や検証を緩めて試験を通してはいけません。

7. 利用者へURLと確認済みカタログを渡し、0.8.1クライアントの設定を検証します。実際のMCPホストの現在の公式手順を確認し、汎用JSONだけで接続済みとしません。CLI/MCPのwallet・vault・relayer・pendingパスを揃えます。APIはSolana mainnet USDC exactとextra.feePayer対応が必要です。sponsorのgas・rentは運用費で、fee debt記録は現在のコードで返金・収益にはなりません。

8. submittedや結果不明では元のintent IDとpending JSONを保持し、status（対応版のresubmit=false）や正本のfetch復旧手順で照合します。新規prepare、state削除、forceNewPayment、別walletへの切り替えで回避しません。署名済み取引の取消、元本帳簿の復元、即時のpasskey復旧を保証しないでください。現CLI/MCPには既存passkeyの条件変更・revoke解除・復旧を完結する専用操作がないため、架空のコマンドや初回setupの単純なやり直しで解決したと扱わないでください。

最後に「設定・起動済み」「操作待ち」「未検証」を分け、タグ／commitと版、変更パス、公開URL、カタログ、バックアップ保存先、秘密を除いた検証結果、次の一手を報告します。秘密や承認リンクは再掲しません。detached、ローカルfork、読み取り検証、実資金mainnetを区別し、未実施の入出金・支払いを成功済みとしないでください。
```

## English A Use an existing relayer

A shorter, self-contained equivalent. Replace brackets with non-secret details, or leave them unknown.

```text
Set up Subly 0.8.1 using my trusted relayer and chosen MCP host or CLI.
Known details: OS [unknown]; host [unknown]; credential-free relayer URL [unknown]; signer type/key file path [unknown]; RPC config location [unknown]; reviewed vault catalogue/selection [unknown].

Inspect your actual tools. Execute reversible local setup if available; without connected tools, give one step and success check at a time, wait for my result, and never claim execution. Ask only for missing non-secret information.

Verify https://github.com/SublyFi/subly-payment-protocol, published pay-v0.8.1 and @subly_fi/pay@0.8.1. Read that tag's packages/pay/README.md, docs/security-model.md and docs/troubleshooting.md; consult deploy/README.md/provider docs as needed. Do not invent commands, assume a public relayer exists, or silently switch versions.

Never request secrets, seeds, credential-bearing RPC URLs or complete config in chat. I enter secrets in my private terminal, outside AI capture. Never dump secret files/environment variables. solana-keygen new prints a seed by default: have me generate keys privately, never through captured AI tools or by pasting the output. Do not overwrite existing keys; explain secure backup. Never log/commit secrets. Preserve existing files/unrelated settings and protect backups.

Use Node.js 24+. Check my host's current official configuration: generic JSON and local stdio MCP are not universal. Use OS-appropriate paths and verify the desktop process environment. Align CLI/MCP wallet, reviewed vault, relayer and persistent SUBLY_MCP_STATE_PATH; check credential precedence without exposing values. One file cannot coordinate separate machines. Never replace vault trust anchors from a remote response or choose by APY.

Check version/help, doctor, vault listing and MCP initialization/tools first. Do not add telemetry. Agree initial deposit and owner policy limits/expiry; I personally review and approve on the correct domain. Once I return and confirm, check setup status before an authorized deposit. Keep links private; explain first-owner registration and passkey/revocation/recovery limits. Current CLI/MCP has no complete existing-passkey policy change, revoke reversal or recovery flow: do not invent one.

This prompt does not authorize real funds. Funding, deposits, paid fetch and withdrawals require my explicit asset, amount and target (API URL plus cap). Existing specific permission remains valid. 1000000 raw USDC = 1 USDC. Yield including fees takes time; only Solana mainnet USDC exact x402 with extra.feePayer is supported.

For submitted/unknown outcomes preserve original IDs and pending JSON. Use same-source status with supported resubmit=false for ordinary vault flows; follow documented fetch recovery. Never delete state, force payment, switch sources, reset principal or disable validation to bypass uncertainty.

Report done, awaiting my action, and unverified separately: versions, changed paths, redacted endpoints, public wallet/vault, pending path, checks and next step. Exclude secrets/capability links. Setup and read-only checks do not establish successful mainnet execution, vault safety or an external audit.
```

## English B Operate your own relayer

```text
Help me operate Subly 0.8.1 using its official deployment guide.
Known details: new install/upgrade [unknown]; workstation/server OS and SSH alias [unknown]; domain/DNS/install path [unknown]; Docker Compose [unknown]; RPC/Pyth config and sponsor key paths [unknown]; existing DB/backups [unknown]; reviewed vault catalogue [unknown].

Inspect actual tools. With terminal/SSH access perform authorized reads and reversible preparation; otherwise give one step/check at a time and wait for my result. Ask only for missing non-secret details. Prepare a concrete change/recovery plan before necessary confirmation for disrupting an existing service.

Verify https://github.com/SublyFi/subly-payment-protocol, published pay-v0.8.1 and @subly_fi/pay@0.8.1. Read that tag's deploy/README.md, packages/pay/README.md, security, validation, troubleshooting and deployment templates. Do not invent commands or switch versions.

Never request secrets in chat or dump secret files/environment variables into output. I enter credentials in my private terminal, outside AI capture. solana-keygen new prints a seed by default: have me generate keys privately, never through captured AI tools or by pasting output. Do not overwrite keys; explain secure backup. Keep secrets out of Git/images/logs/history. Preserve existing files. For upgrades establish DB backup/restoration and migration/old-process shutdown plans; do not mix versions, reset principal or assume binary-only rollback is safe.

Follow the guide for Node.js 24+, Compose, dedicated mainnet RPC, Pyth, a separate sponsor hot-wallet file, PostgreSQL and Caddy HTTPS. Restrict secret permissions, use my own domain for owner URLs/WebAuthn, enforce mandates, keep admin tokens server-side and DB/relayer ports private. Confirm new purchases and do not add telemetry.

Validate public vault metadata/chain accounts and let me choose. Preserve retired vaults with funds or pending operations; use multi-vault Compose files consistently. Check config without expanding secrets, HTTPS, health/readiness, catalogue, backups/restoration preparation and sponsor monitoring. Run read-only mainnet validation when prerequisites exist; report missing shares/inputs as unverified.

This prompt does not authorize funding, deposits, paid fetch, withdrawals, LUT creation or invest. Require explicit target plus amount or scope/fee limit, including scheduled execution. Consider extra LUTs only when current withdrawals require them. I personally review owner setup and approve; do not impersonate me. Never weaken accounting or validation to pass tests. Yield takes time; gas/rent is an operating cost and fee-debt accounting is not reimbursement.

Verify pinned clients and my host's current official MCP setup. Align CLI/MCP wallet, vault, relayer and pending path. Only compatible Solana mainnet USDC exact x402 APIs with extra.feePayer work. Preserve original IDs/state for uncertain outcomes; use supported resubmit=false status or documented fetch recovery, not repeated preparation, resets or forced payment. Do not promise cancellation or immediate passkey recovery. Current CLI/MCP lacks a complete existing-passkey policy change, revoke reversal or recovery flow; do not invent commands or claim initial setup solves it.

Report configured/running, awaiting action, and unverified separately: tag/commit/version, paths, public URL, catalogue, backup location, redacted checks and next step. Exclude secrets/capability links. Distinguish detached development, local fork, read-only checks and actual funded mainnet execution; never claim unperformed validation or an external audit.
```
