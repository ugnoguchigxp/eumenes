# Codex の検索による調べもの（web.note）

2026-11-11、利用者の決定に基づく。「`web_search` は残すが、ツールチェーンでも選択されないようにし、代わりに Codex SDK（Luna）による検索ツールを登録して、agency の標準検索ツールにする」。

## 決定の根拠（測定）

同じ実依頼10件×2で、Codex SDK + Luna（reasoning low、Codex のライブ Web 検索）は20/20回答、中央値 28.6 秒（p90 46 秒）、未キャッシュ入力は約25kトークン/件。Eumenes の `web.search` は自身の記録で中央値約46秒、直近10件は成功4・一部5・失敗2。`web.research`（Pursuit）は中央値約9.5分。盲検のメモ品質は同等。

## 何をしたか

| 項目 | 内容 |
| --- | --- |
| 新しい担当 | toolchain `web.note`（関数 `web_note`）。package `web.note` は backend `web-note`、binding `web.note@1` は `execution:"task"`・adapter `adapter:web-note@1`。bundle は `api/domains/capabilities/bundles/web-note.bundle.json`。`general` なので、専用担当がなければ検索の汎用枠に出る |
| 返すもの | 調べもののメモ。題・要約（1〜2文）・Markdown 本文（日付と出典1〜3件）。agency の調べもの担当と同じ指示（profile と SKILL の本文。今日の日付は実行時に `{{today}}` へ入る） |
| 実行 | 新しい domain `web-note`（表 `web_note_runs`、queue ジョブ `web-note.run`、資源 `codex.search` は同時2）。1件につき Codex SDK のスレッドを新しく作り、`modelReasoningEffort:"low"`・`webSearchMode:"live"`・read-only・承認なし・空の作業ディレクトリで1ターン（値は `api/domains/web-note/service/policy.json`）。SDK の呼び出しは `packages/coding-runner/src/codex-turn.ts`（`@openai/codex-sdk` はこの package からだけ解決できる）、Codex の実行ファイルと見せる環境は既存の `codexRuntime`、機能の無効化は `disabledFeatures` から `code_mode_host` だけを除いたもの（Codex の Web 検索はこの host を通る。無効にすると検索0回で「検索できなかった」と答える。2026-11-11 実測、下記）、設定は `api/application/web-note/codex-web-note.ts` |
| モデル | 会話の LLM 設定に関係なく gpt-6-luna に固定する（利用者の決定 2026-11-11「LLMの選択に関係なく codex-sdk lunaを検索に使う想定にしていいです」）。値は `api/domains/web-note/service/policy.json` の `model` だけに書き、AGENTS.md の「モデル名をコードに書かない」決まりの例外として `api/application/fixed-names.test.ts` の `decidedModelFiles` に1ファイル・1行だけ認める。最初の版にあった設定 `agency.searchResourceId` と設定画面の項目は取り除いた（`settings.conversation@11` は @9 と同じ項目。保存済みの文書にこの値があれば読み込み時に捨てる） |
| 失敗 | Codex の実行ファイルがない・ログインしていない・終了コード異常・空の答え・出力が大きすぎる・期限切れは、理由コード（`web_note_codex_unavailable` `web_note_codex_not_logged_in` `web_note_codex_exit` `web_note_empty_output` `web_note_output_limit` `web_note_deadline_exceeded` `web_note_turn_failed`）つきで `failed`。メモは作らない。provider の文面は記録に入れない |
| 取消 | 作業の中止信号（queue ジョブの期限と取消）を Codex のターンへ渡し、止める。ユーザーの取消は `cancelled`。忘却は run を消す |
| 記録 | 1回のターンごとに、推論台帳へ Codex SDK の試行として1件（`connection_kind=codex-sdk` `billing_path=codex`、入力・キャッシュ読み・出力・推論トークン）。失敗・取消も理由つきで残す。`InferencePort.recordExternalCodexAttempt` |
| 結果の形 | `ExecutionResult` に `title` を足し、`answer` に本文、`summary` に要約、`sources` に本文中の出典を入れる。会話は通知（task_result）から、agency は台帳（`resultsInTransaction`）から読む |
| 完了通知 | `web.research` と同じく完了通知の対象にしない（`WEB_RESEARCH_WORKS`）。結果は返事に添える |

## 選択の扱い

- 定義の任意項目 `selectable: false`（toolchain のみ）を足した。立てた revision は、Router の cards、検索の候補（`find_toolchain`・agency の能力検索）、agency の能力一覧（`agency-actions` の catalog と、実行の口が無いときの `agency-state` の予備の一覧。一覧に無いので agency の `start` からも起動できない）、検索の評価、パイプラインの部品の一覧、ベクトル更新から外れる。revision の登録・`resolveToolchainInTransaction`・`toolchainSetInTransaction`・作業が自分の revision で引く card は変わらない。名前を指した実行（既存の作業・試験）は従来どおり動く。
- `web.search` は revision 11 で `selectable: false` にした（本文は10と同じ）。`web.research` は変更しない。
- agency の調べものは `toolchain:web.note@…`（承認不要のもの）だけを選ぶ。無ければ「できなかった」として agent に返す（従来と同じ）。`web.research` へは回さない。

## 実 Codex での確認（2026-11-11、codex-sdk 0.160、gpt-6-luna、low、live）

| 確認 | 結果 |
|---|---|
| `disabledFeatures` をすべて無効（最初の実装） | 検索0回。「Web検索のツールを実行できなかった」と答えた |
| 各機能を1つずつ無効にした18通り | `code_mode_host` を無効にしたときだけ検索0回、ほかは1回 |
| `code_mode_host` を残した本番の指示文：日の出・日の入り | 27.6秒、検索2回、入力 53,638 tokens（キャッシュ 36,352）、出力 442。条件どおりの時刻 |
| 同：URL（eumenes_steer のリポジトリ） | 41.8秒、検索3回、入力 92,725 tokens（キャッシュ 67,200）、出力 1,170。リポジトリを読んでまとめた |

要約の行に「要約: 要約:」と2回付くことがあったので、題・要約の見出しは重なっていても外す。本文の URL のうち URL として読めないものは出典にしない（メモ全体を失敗にしない）。

## 残っていること

- Codex がログインしていない環境では `web.note` は「失敗」として終わる。実行ファイルが無い環境では担当そのものを出さない（`web-note` backend が有効にならない）。
