# 会話メイン200k・サブ既定128kの実装と確認

2026-11-01 JST。[設計](../../larm-agent-capacity-design-2026-11-01.md)と利用者の指定に基づく。LARM側の指定HTMLはgnosisで読み取り確認した。サーバーの起動・停止・再起動、製品設定・製品DBの変更は行っていない。

## 実装

| 場所 | 内容 |
| --- | --- |
| `api/domains/larm/service/agent-connections.ts` | 会話・エージェント・履歴分岐→役割、容量、独立client、既存port/leaseの対応。inspectでconnection ID・bootEpoch・状態を確認でき、Bearerは公開しない |
| `api/domains/larm/service/generation-lanes.ts` | inference全体で共有するmain 1件・sub/独立補助2件の待機列。取消された待機要求を除き、subをmainへ昇格させない |
| `connect.ts` / `establish.ts` / `agent-capacity.ts` / `context-capacity.ts` | mainだけcontextTokens=200000、省略subは131072を照合。createの同一通信再試行は同じUUID、claimには冪等キーなし。ready・claimable・実確保容量を検証。catalogは上限、claimは入力予算の正本 |
| `refresh.ts` / `profile-retention.ts` / `profiles.ts` | 既存renew・再claim・releaseを再利用し、要求役割とbootEpochを保持。接続・credentialの短い方を期限とし、容量変更を拒否 |
| `chat-request.ts` | 通常のOpenAI bodyへ不透明なprompt_cache_keyを追加。messagesは毎回送信。connection ID・役割・slotや内部ヘッダーは送らない |
| `api/domains/inference/service/configured-larm.ts` / `index.ts` / `attempt-*.ts` | 実際に保存設定から構築するportへ上記接続管理と共有実行枠を組み込み、構造化した所有者情報を渡す |
| `api/domains/dialogue/service/routed-turn.ts` など | 実会話メインが会話IDを明示してmainとして呼ぶ。specialist・command・task実行・browser/extractは管理上のtask/session IDを渡す。会話に属さない補助は独立request IDを使う |

主会話の処理を中断する変更はない。新clientは役割・容量で分離し、旧128kのclientを200kとして採用しない。メインの実行中は共有待機列で自然終了を待つ。既存のonConversation補助の譲歩・取消規則は維持した。音声Providerは元の独立scopeを使い、LLM接続のために削らない。不明な生成POST結果を接続再作成だけで再送する変更もない。

固定容量の分岐は、利用者が指定した外部API契約の強制に限る。会話本文、入力先頭、モデル名、profile名、connection IDの文字列から意味や役割を判定する処理は追加していない。

## 固定・結合試験

- 変更前の接続・lifecycle・直列化・安定clientの20件が成功。
- 容量専用10件とapplication結合1件、command結合8件の対象19件が成功。main/sub双方のready/claim容量不一致、Bearerの分離、会話/agent/branchの混同防止、再利用、UUID再送、claimable待機、1+2枠・追加待機・待機取消、renew、idle release、bootEpoch変更、JSON/SSE、不明なPOST結果の非再送、ログの秘密非出力を確認。
- 実会話のrouted turnがmainの会話・エージェントIDを渡すことを検証。別の結合試験はカスタムLARM factoryを使わず、実際のinference構築から200000のcreateとsubの省略要求、main継続時の接続再利用まで通した。
- 最終 `bun run verify -- --domain larm --domain inference --domain dialogue --domain agent-runtime --domain tool-runtime --domain voice-dialogue` は **backend 1616件、Web 95件成功**。型・境界・SQL境界・指示カタログ・整形・lint・サイズ・DesignSystem検査も成功。入力変更による無効化なし。
- 検証run: `2026-10-31T23-18-51-161Z-017f96c1-bcc7-444e-9113-f75ce1bcc3d6`。baseCommit `10ba1eaeeb386486f3a8ec6020f2ba84f67723e2`、revision `8e6a48424e32ef93e9ec1e06bc94235e7e19d997a383991010f8283d4d44f5da`。[report.json](../../../verification-reports/runs/2026-10-31T23-18-51-161Z-017f96c1-bcc7-444e-9113-f75ce1bcc3d6/report.json)。選択範囲外の既存 `docs/domains.md` の生成表不一致は警告として残し、修正していない。
- 途中のverifyは、結合試験の配置違反と、追加したagentSessionを含まない旧期待値で停止した。配置をapplicationへ移し、所有者情報を明示して検証する期待値へ更新した。要件・検査閾値を弱めていない。
- UIの変更がないためブラウザーE2Eは省略。音声の既存backend/Web試験は成功したが、実マイク・スピーカーの3往復受入は今回行っていない。

## 実LARM

settings domainの読み取り専用操作で保存済み接続を取得し、隔離した一時DBの設定APIへ保存。実inference構成から検証専用の会話・エージェントを呼び、終了後は検証用接続と一時DBだけを片付けた。確認スクリプトは `bun scripts/larm-agent-capacity-live.ts --run`。新規の短い確認入力だけを送り、会話本文・credential・Provider生応答は報告に保存しない。

08:13 JSTの実測では、main 200000とsub 131072×2のclaim、3件の並行呼出し成功、mainの継続利用、JSON 1回・SSE 3回のHTTP200と非空の応答を確認。全4回にprompt_cache_keyがあり、独自connection/role/slot項目はなかった。生成経路は成功したが、当初runnerが既存の音声・態度判定用scopeをLLM接続に数えたため、全体の集計はfalseになった。これは3本のLLM容量の不一致ではない。[初回観測の要約](live-initial-summary.json)は会話に出力済みの結果から作成した要約で、Providerの生応答ではない。

集計をLLM Providerで絞るよう修正後、08:18 JSTの追加確認は接続作成HTTP503で終了し、生成は0件だった。[追加確認結果](live.json)。その後の読み取りではLARM `/ready` と `/v1/activity` が200、activeWorkloads=1で、公開応答のbootEpochも取得した。原因の断定やサービス操作・他の利用の停止は行っていない。同じ状態のまま実生成を反復していない。以降のrunnerは実行時刻ごとの結果ファイルを作り、以前の結果を上書きしない。

最終の記録ファイル名の調整はrunnerの出力先だけであり、製品の生成・接続コードは最終verify後に変更していない。

## 配備状況と残る受入

LARMは指定の混在容量を配備済みで、今回もその実確保容量と通常生成を観測した。Eumenesの**実会話メインのコード経路は200000を要求する実装になった**。ただし、稼働中backend PID 99549（08:02:26 JST起動）の起動時source digestは記録されておらず、本作業では再起動もしていない。現在の稼働版への最終差分の反映・稼働中の会話メイン200kは未確認とする。稼働ログには新しい役割・容量の項目がなく、それだけで反映済みとは判定しない。

作業中に別操作でmainのcommit/pushが進み、途中までの接続管理がcommit `10ba1eae` に含まれた。その後の改善・追加試験等は作業ツリーに残る。こちらから別チャットへの連絡、commit/push、ブランチ作成は行っていない。担当外の既存差分を保持した。

稼働受入の続行条件は、利用者によるサーバー操作の明示許可と、LARMが接続作成を受付できること。その後、最終差分を反映した稼働API/CLI会話と役割・容量ログを照合する。今回の隔離live成功を稼働backendへの配備完了とは扱わない。
