# LARM容量契約の修正と受入

2026-11-01 JST。503統一とは別の契約不整合。

## 原因と修正

運用ログ・稼働中APIで`larm_claim_context_mismatch`を確認。catalogは提供可能な上限、createのcontextTokensは明示要求、claimは確保された容量なのに、上限と確保値を完全一致で比較していた。

`api/domains/larm/service/context-capacity.ts`の照合を`connect.ts`から共通利用する。claimの正の安全な整数・広告上限以下・明示要求との一致・ready応答が容量を持つ場合の一致を確認し、他のcontextWindow項目やモデル・プロトコル・接続先などの検査は維持する。主200k明示・補助省略の方針を変えず、予算は既存どおりclaim由来のProviderを使う。

意味判断・LLM指示・Profile名・モデル名による特別分岐は追加していない。接続境界の外部契約の検証に限定した修正。

## 実装版と稼働版

修正は別作業の一括commit `10ba1eaeeb386486f3a8ec6020f2ba84f67723e2` に含まれた。修正ファイルはこのcommitから変更されていない。

- context-capacity.ts SHA-256: `db455eef0f2aaa82e2ee9a1457f8662fe8b65d79ca769eede4ff6f1b874d3a8f`
- connect.ts SHA-256: `d396b45dc360056cfeaa837d8bd41b964dfa643c21d49910d2234a62ebd474ab`

調査時の稼働backendはPID 99549、08:02:26 JST起動、cwdは`/Users/y.noguchi/Code/eumenes`。起動時source digest未記録のため、その未コミット差分を含む厳密な旧実行revisionは確定不能。修正後の別プロセスによるliveを稼働backendへの配備完了とは扱わない。

## 固定試験

- 変更前: 既存接続・lifecycle・context試験42件成功。
- 修正後: 対象5ファイル72件成功。ready/claim容量不一致の回帰を追加後、専用試験17件成功。
- 型検査: 2777ファイル成功。今回の4ファイルのlint・整形も成功。
- `bun run verify -- --domain larm --domain inference --domain dialogue`: inventory・境界・system-context成功後、既存差分の関数サイズ超過で停止（index.ts#createLarm、lease-manager.ts#createLeaseManager）。要件や閾値は変更していない。
- domain試験: 159ファイル1217件中1216成功・1失敗。`dialogue/test/command-interactions.test.ts`が、別作業で追加されたagentSessionを含まない旧期待値で失敗。担当外として未修正。
- 接続管理が別作業で更新中のため、上記を最終版全体の検証成功とは扱わない。修正ファイル自体のdigestは不変。

## 実LARM受入（08:10〜08:12 JST）

保存済み接続設定をsettings domainの読み取り専用操作で取得。主・補助それぞれ独立した調査用clientを使い、既存のcreate/get/claim/retain/count/generation/releaseを通した。生成は短い検証入力だけ。秘密・会話本文・Provider生応答は本報告にも運用ログにも保存しない。

| 役割 | 広告上限 | 実確保容量 | JSON | SSE | 同一接続の維持 | 解放 |
| --- | ---: | ---: | --- | --- | ---: | --- |
| sub | 200000 | 131072 | 成功 | 成功 | 73.027秒 | 204 |
| main | 200000 | 200000 | 成功 | 成功 | 71.158秒 | 204 |

補助はcreateにcontextTokensを送らず、主だけ200000を送信。両方で30秒周期のProfile保持要求が2回通り、connection IDは不変。catalog 200、create 201、claim 200、正式入力計数200、JSON/SSE生成200。出力64tokenの入力予算は補助129032、主197960となり、実確保容量−64−安全余白1976と一致。

LARMへ不正な容量を送信した実測: -1はHTTP400 `invalid_request`、200001はHTTP400 `context_capacity_unavailable`。いずれも生成・Connection確保なし。

容量を指定しない起動時probeと同じ標準経路でも、createLiveLarmで接続し、131072の実容量・JSON・SSEの成功を追加確認した（`default-live-report.json`）。

詳細は`live-report.json`。音声・ブラウザー表示の変更ではないため、ブラウザーE2E・実機器音声受入は対象外。

## 残作業

接続管理改修が未完了で、同じファイルに更新が続いている。利用者からも進行中と確認済み。改修完了後の版で検証結果を固定し、本番反映に必要なサーバー操作の事前許可を得て、稼働APIと会話入口から生成を確認する。現時点でサーバー操作・設定変更は実施していない。

## 統合版の最終検証

並行作業の修正後、関連6domain（larm/inference/dialogue/agent-runtime/tool-runtime/voice-dialogue）のverifyが全工程成功した。
`verification-reports/runs/2026-10-31T23-18-51-161Z-017f96c1-bcc7-444e-9113-f75ce1bcc3d6/report.json`
のresultはpass。開始・終了・確認時のsource revisionはすべて
`8e6a48424e32ef93e9ec1e06bc94235e7e19d997a383991010f8283d4d44f5da`。
先に記録したサイズ超過とcommand-interactionsの失敗は並行作業側で解消されており、
こちらでは担当外を変更していない。検証済みの同一source revisionの結果を再利用し、同じ総合試験は重ねて実行しない。

配備前のソースはbase commit `10ba1eaeeb386486f3a8ec6020f2ba84f67723e2` と、検証された後続未コミット差分。容量修正2ファイルのSHA-256は上記のまま。
サーバー操作の事前許可を現在の会話で依頼済み。稼働への反映・配備後確認は未実施。

並行作業の後続liveが503で停止した観測は、08:10〜08:12の本チャットの成功を上書きせず、別の資源受付結果として扱う。省略128kを広告200kと比較して拒否する元の不具合とは別。
