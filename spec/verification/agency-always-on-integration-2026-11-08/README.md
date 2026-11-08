# always-on取り込みの実装・固定検証

2026-11-08。利用者の実装開始指示に基づく。**稼働反映前。実モデル・利用者Web・実機器の受入は未実施。Live音声の提案と実字幕の対応づけには契約不足が残る。**

## 実装した動作

- 保存設定の`agency.runtime`でFとalways-onを排他的に切り替える。既存設定はFを維持し、失敗時にFを自動起動しない。切替前の推論を終了・照合してから新しい所有者を開始する。
- 常駐思考は独立したLARM接続・生成枠を使う。保存済み専用リソースを選んだ場合、利用不能時の代替は行わない。呼出回数・費用の上限は追加せず、準備には既存の同時数・日次回数・受付間隔・能力別制限を残す。
- 利用者の新規入力では思考を中断せず、古い行動を受付・配送前に拒否する。入力中、発話枠の使用中、Live再生中、通常会話の生成中には新規tick・発話を抑止する。画面から送るのは状態フラグのみで、入力文は送らない。
- Memory Stateを利用者の事実の正本にする。原観測本文は既存Memory Recordsへ保存し、ホストのcheckpointには本文を複製しない。観測・過去の思考・準備・返却・通常応答まで入力の版を継承し、不完全な入力は推論へ送らない。
- 保存済みの実在する票と引数・能力revision・入力版・権限・予算を検査し、既存executionを使う。旧intent/candidateを作って新票を正当化しない。同じ結果の採用とcheckpoint・feed cursorを一つのwriterで確定し、rollback時は揮発状態も戻す。
- 準備した成果と成果物を既存State・Work・Resource経路で通常応答へ渡す。通常応答で共有した内容は確定した会話観測を次のthinkへ渡し、LLMが既存`stock.drop`で整理する。自発発話の成功receiptだけが`usedAt`と未返答数を更新する。
- 実配送済みの文字発話を一度だけ数える。結果不明のLive提案は成功扱い・再送しない。忘却、訂正、期限、未知形式、読めない原記録、再起動、別会話の継続を接続した。
- 設定画面は既存bundleに会話設定revision 9を追加した。runtime、思考用リソース、10/60/600秒の最短間隔、思考の深さを保存する。既存revision 8の定義は変更しない。数値selectは既存契約で許されないため、最短間隔は数値欄とし、保存時に3つの値だけを許可する。

意味理解・共有内容の判断・準備内容の選択はLLMへ委ねた。ホストに加えた分岐は版、権限、票、実行・配送状態、画面leaseの契約検証に限定した。モデル名やprofile名の固定は追加していない。

## 採用物

取り込み元の着手時ソースは`always-on-24`（dirty）。採用した契約は`always-on-26`。配布物は`vendor/agency/eumenes-agency-0.1.5-c632b5632390-b8b87f7c1f33.tgz`、SHA-256は`b8b87f7c1f3369e524b48a2a1decd4c1bc4601a03f58b5311434235e655f84b7`。

manifest・採用patch・checksum・lockfile・導入済み配布物を照合した。commitとpatchから59ソースを別の一時領域へ再構成し、manifestの全hashと一致した。上流で後から追加された`src/agenda/`の4ファイルは採用していない。採用済み59ファイル自体のhashは現在の上流とも一致する。詳細は[配布物の照合結果](adoption.json)。

## 固定検証

| 検証 | 結果・範囲 |
| --- | --- |
| 最終の対象回帰 | **46 pass / 0 fail、9ファイル**。新規always-on 17件に加え、旧Fの行動、LLM接続、配布物照合を含む。[ログ](targeted-tests.log) |
| 設定・推論の追加境界 | **27 pass / 0 fail**。保存・再読込、許可値、実在する登録画面からの保存、独立control、専用リソースの無断代替拒否。[ログ](settings-inference-tests.log) |
| LARM容量・接続 | 独立思考の追加試験を含む11件成功。通常会話・yieldする記憶整理・専門担当と別枠で開始し、思考が互いのpreempt対象にならず、接続を再利用することを確認。実LARM容量は未受入 |
| Web固定試験 | **69 pass / 0 fail、14ファイル**。画面lease、音声出力枠、設定、再生。[ログ](web-tests.log)。画面なし環境で音は出していない |
| 上流全試験 | **1,036 pass / 25 skip / 1 todo / 0 fail、89ファイル**。[ログ](upstream-tests.log)。型検査・lint・境界検査も成功 |
| 上流の標準verify | 他作業の`examples/virtual-eumenes/agenda/{docs,memory,research}.ts`の整形で停止。成功扱いにせず、試験・型・lint・境界を個別に記録 |
| 所有domainと利用側の広域回帰 | **2,010 pass / 12 fail、332ファイル**。失敗は今回未変更の`api/application/toolchain/specialist-dialogue.test.ts`。後述。[ログ](broad-domain-tests.log) |
| Eumenesの標準verify | 保存済みの`artifacts/pursuit-integration-20261106/`内のコードコピーが未登録試験として検出され、inventoryで停止。試験登録を削除・弱化して通していない |
| 型・静的検査 | 最終の`bun check --no-pretty --all`は成功。今回の58ファイルの整形、対象lint、境界、SQL境界、size、domain-docs、SystemContext整合が成功。全体整形は今回未変更のbundleで失敗。[記録](static-checks.json) |
| Webビルド | `/tmp/eumenes-always-on-web-build`への隔離ビルド成功。稼働中の配信物は置換していない |

広域回帰は最終の小さな入力完全性検査・指示追加・検証関数分離の前に固定して実行した。その後に変えた箇所は最終46件、対象型・静的検査、指示生成の照合で確認した。実行中に製品ソースを書き換えて広域結果を合格扱いしていない。

広域の12失敗は、制作担当が`specialist_invalid_contract`になることを個別のfixtureでも確認した。`specialist-prompt.ts`と`specialist-turn.ts`は着手前のhashと一致し、そのfixtureはAgencyを組み立てていない。現行のstateful契約に対する既存scriptの不一致として切り分け、要件・期待値や担当外の製品コードは変更していない。既存全体が合格したとの意味ではない。

型検査中には並行作業中のMarkdown試験に一時的な型エラーも観測したが、最終検査では解消している。全体整形の未変更箇所は`browser-interact.bundle.json`、`markdown.bundle.json`、`pursuit-research.bundle.json`。今回の対象差分の整形は成功している。静的診断は標準verifyの合格を代替しない。

## 実装中に追加で確認・修正した境界

| ID | 内容・対応 |
| --- | --- |
| AO-N11 | 数値selectが既存画面契約で拒否される。既存の数値欄と型付き保存を使い、10/60/600秒以外はschemaで拒否する |
| AO-N12 | 成功した発話票を無期限に残すと、原観測の保持窓から外れた後の復元で再採用する可能性がある。成功のcore反映後にホストの未確定票から除き、異常終了時だけ実際の文字配送と照合して一度採用する |
| AO-N13 | 忘却時に全会話を一律に無効化していた。提示中の入力を含めて依存するscopeだけを失効し、独立したBの推論が続くことを実試験で確認した |
| AO-N14 | 最初の忘却前でも入力manifestが不完全なら推論へ送ってはいけない。呼出し前後の完全性検査と、出典が確定しないWorkを提示しない処理を追加した |
| AO-N15 | tick本体内の保存だけではschedulerが更新した待ち時間を取り逃がす。更新後の`onSettled`でcheckpointを保存し、20秒へのbackoffが再起動後も残ることを確認した |
| AO-N16 | 未知形式・読めない原記録が一つあると全会話の復元を妨げる。schemaと原記録を確認し、そのscopeを隔離する。独立した会話Bの復元を確認した |
| AO-N17 | 訂正で永久失効した原観測IDを新しい版の入力へ戻すと新観測まで拒否される。新しい観測IDとMemoryの版付きstampを使い、古い派生状態を消して訂正版を読み直せることを確認した |

## 未完了・次の受入条件

1. **P5 / AO-N6: Liveの実発話との対応づけ。** 現行の`session.commentary.append`には提案用`event_id`があるが、実字幕の通知はspeaker・本文・時間だけで、提案IDを返さない。`sessionInput`に提案の出典があることだけでは、その提案を話した証拠にならない。本文照合や「直後のassistant字幕」から推定して票へ付け替える実装は行っていない。必要な外部契約は[残る配送契約](delivery-contract-gap.md)。不明な提案が残る間は追加の自発発話を保留し、新規user入力または復旧時に照合・破棄する。
2. **P6: 標準verifyの全体合格。** inventoryに入る保存コピー、制作担当fixtureの契約不一致、担当外の整形を各所有箇所で解消した後に再実行する。今回の期待値を弱めて合格させない。
3. **P7: 稼働反映・実モデル・実機器。** 保存済み設定での実性能・能動性・費用・Live容量、利用者Webでの自然な準備共有、静穏希望への応答、実機器3往復を確認する。稼働サーバー操作・設定切替・実プロバイダー呼出しは未実施。音声MVPの完成は宣言しない。

[実装計画](../../agency-always-on-integration-plan-2026-11-08.md) / [契約と検証の対応](contract-matrix.md) / [機械可読結果](results.json) / [着手前hash](baseline-source-hashes.json) / [対象差分のhash](owned-source-hashes.json)
