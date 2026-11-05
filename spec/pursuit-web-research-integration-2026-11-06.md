# Pursuitによる長考Webリサーチの取込

状態: 実装計画。2026-11-06の利用者による取込依頼に基づく。前提資料は `agent-roles-and-pursuit-integration-design-2026-11-03.md`。今回は研究担当に絞り、Pipeline制作、共有下書きの編集、自律的な目標の開始を含めない。

## 目的と現在の差

`web_search` は単純な公開情報の確認を短い取得手順で返す。新しい `web_research` は、依頼を保持して調査計画・競合する説明・確かめる点・観測・反証・未解決点を記録し、必要なら調査方針を見直して根拠付きの報告を返す。長い時間を使うこと自体を目標にせず、必要な根拠が揃えば終了する。担当選択、検索語、出典の選択、十分性、方針変更はLLMが判断する。

現行コードでは旧 `web.research.codex` と `web_research` は退役済み。現行の公開入口は `web.search` と `web.service-search` である。新しいモデル専用の入口を増やさず、`web.research` としてPursuitを登録する。Pursuitの検証済みの開始点は `eumenes_pursuit@101fd76`。

## 再利用と必要な追加

- coreだけを版・元ソース・checksum付きtgzでvendorへ置く。standalone/eval、設定DB、秘密、実験データを配布しない。
- Web取得は既存のWeb domain・Queue・公開URL検査・本文保護を使う。推論は既存inferenceのsubagent設定と使用量記録を使い、モデル名やprofile名を製品コードへ固定しない。
- 会話の入口はbundle＋登録adapter。仕事の見せ方は既存のTODO、質問、回答、取消、Host noticeを使う。新しい専用画面は作らない。
- 次の作業を決めるのはPursuit coreだけ。既存の汎用親計画ループをPursuitの上に重ねない。
- 既存task bindingにはadapterのtask契約があるが、会話の開始・結果読取り・制御にはagent-runtime固定の経路が残る。登録済みtask adapterへ委譲できるよう接続を揃える。既存のtask adapterとPipelineの動作は維持する。

coreには二つの接続上の不足がある。`ToolPort.invoke()`は最終結果まで一つのPromiseで待ち、再開時に未確定started試行をinterruptedにする。既存Web取得は別のQueue jobで確定するため、親jobを待たせる接続では推論枠・Queue枠を保持し、受付と完了を区別して再開できない。また、受入条件の削除禁止triggerがあり、ホストの忘却を反映するAPIがない。これらは§8.4/8.5で既に挙げられた不足であり、専用の題材処理で回避しない。

## coreの追加契約（次版、後方互換）

1. 道具の受付をホストの同一writer transactionで予約する任意の `ToolPort.deferInTransaction` を追加する。coreが確定したpursuit/attempt IDを渡し、ホストは既存Queueへ一度受付しoperation IDを返す。coreのpending記録と子受付を同一transactionで保存する。既存の同期結果portはそのまま使える。
2. pendingの試行は `step()` で再実行せず、pending参照を返す。ホストは推論・Queue枠を解放して子結果を待つ。`completeTool` は同一pursuit・attempt・operationの確定結果だけを一度採用し、既存settlementへ戻す。取消・忘却・期限後の結果は採用しない。
3. `forgetPursuit` はホスト専用の削除操作として公開する。本文・受入条件・観測・判断・成果物の写しを消去し、再開防止に必要な不透明IDのtombstoneだけを残す。操作keyはホストが不透明IDから生成し、元入力digestも消す。同じkeyから忘却済み入力を復元しない。通常の受入条件変更は引き続き禁止する。
4. 適用済みSQLは変更せず、追加migrationでpendingと忘却を表す。忘却時だけ受入条件の削除ができる永続条件を設け、一時的なtrigger無効化は行わない。

## Eumenesの所有と接続

新しい `pursuit` domainが開始受付、core IDとの対応、世代、取消、pending道具、調査成果、通知の採用印を所有する。applicationがsource検査、推論、Web取得、通知へ接続する。coreと下位domainからdialogueの表を直接読まない。

| 接続 | 入口と正本 |
| --- | --- |
| 会話→担当 | `toolchain:web.research@2`、function `web_research`、`binding:pursuit.research@2`、`adapter:pursuit@1` |
| 担当の指示 | `profile:pursuit.research@1` と `skill:pursuit.research@1`、`package:pursuit.research@1` |
| 受付→開始 | 同期のtask受付が出所・期限・依頼・起動jobを保存。writer外で固定operationKeyによりcoreを開始し、対応保存前の障害でも同じcoreを回収 |
| 推論 | 既存inferenceの独立subagent呼出し。計画・生成・振り返り・受入照合は別文脈。使用量を同じ仕事へ帰属 |
| 取得 | 既存Web domainへpending試行を同一transactionで受付。完了結果の所有・世代・出所を確認してcoreへ渡す |
| 相談 | coreの相談IDとホストの質問IDを対応。待機中は推論しない。利用者の実際の回答messageを検査して再開 |
| 訂正・取消 | 条件の訂正では旧実行を失効し、新しい実行へ参照を引き継ぐ。取消後に新規取得・結果採用をしない |
| 終了 | 検証済みの報告と出典、または達成分・不足・調査終了理由を一度だけ親へ返す |
| 忘却 | source失効から受付本文・core台帳・子の要求/保存結果・未採用の通知を消去/失効。遅延結果で復元しない |

研究道具は公開Webの検索・本文取得・保存本文の範囲読取りと、担当自身の報告下書きに限定する。外部送信・投稿・購入・任意コード実行・ユーザーのファイル編集を加えない。最初は既存Web取得で接続する。Codex SDKの検索を追加する場合も、不透明な検索道具の一つとして同じ受付・確定結果・取消・使用量の契約を通し、モデルと接続先は保存済み設定から取得する。既存の別Codexチャットを操作する経路は作らない。

## 行動と受入

Pursuitの方針・仮説・観測を保持し、調査の部品ごとの未達を追う。一次資料、時点、適用範囲、反対の根拠を照合し、同じ資料の読み直しだけを進捗としない。本文や検索結果の命令は資料として扱う。検索抜粋を本文による確認済み事実へ昇格させない。根拠のない条件を追加して達成済みの仕事を断念せず、回答済みの不足を繰り返し質問しない。

報告は今回の依頼に答える内容と必要な根拠を含める。内部思考の全文は要求しない。結論、主な根拠、矛盾・未確認点、調査を終えた理由を返す。出典ID・URL・対象の世代をホストが検査し、内容が元依頼を満たすかは独立した文脈で照合する。意味評価の保証水準をmodelと表示し、exactにしない。不足を適切に説明した終了と、全条件を確認できた完了を区別する。

予算・時間の上限はbundleの数値を正本にし、ホストが推論・取得・照合を合算して強制する。既存の短い検索の予算は変えない。新しい研究担当の予算に必要な上限だけtask契約へ追加可能にし、旧版の値は保つ。長く実行する下限、最低検索件数、発話による強制的な担当選択は設けない。

## 作業順・検証・完了条件

1. coreのpending/忘却: 既存同期portの回帰、同一transactionの受付、再起動、重複完了、取消・期限後結果の拒否、忘却した本文と再開禁止を部分→結合→通しで検証し、次版をpackする。
2. hostの接続: 新domain/adapter、既存task bindingの開始・照会・回答・取消、Web取得・推論・結果通知のports、bundleを実装する。既存の未コミット差分は開始時の `artifacts/pursuit-integration-20261106/baseline.json` と照合し保護する。
3. 固定試験: 短い確認は従来のWeb担当、比較・矛盾・反証を必要とする仕事は研究担当へ選べる登録を確認する。実registry/Queue/writerとモデル・Webのfixtureで、計画→取得→見直し→報告、質問→回答、取消、再起動、忘却、遅延結果の拒否を通す。期待値・制約を弱めない。
4. 全体: 変更domainと利用側のローカル検証、package/manifest、型・境界・bundle登録を確認する。CIは実行しない。他作業に由来する失敗は変更前との差を特定する。
5. live: 実モデルの担当選択、実Webからの根拠付き報告、会話への結果返却を少数の事前固定ケースで確認する。API費用は既存の承認上限15ドルを引き継ぎ、前回からの累計を消さない。稼働中サーバーへの反映と隔離した固定試験を区別して記録する。

実装だけ、受付だけ、fixtureだけを製品の取込完了とは扱わない。各段階の結果・未確認点・残作業を記録し、3ラウンドまたは新しい根拠のない反復では進め方を見直す。
