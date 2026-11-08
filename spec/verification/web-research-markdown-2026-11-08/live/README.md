# 実接続の確認

2026-11-08。ユーザーの起動許可後に既存の `bun run dev` でAPIとWebを起動した。起動後は公開APIとCLIだけを使い、DBの直接参照、接続設定の変更、モデルの固定、サーバーの再起動は行っていない。

## 条件と完了条件

- 保存済みの推論設定を使用。保存済みの経路は `cloud-only`。LARMを使うルーターと、実際の調査の推論先は区別する。
- Doclingは既存のGET/PUTが利用可能。拡張library/folder APIは利用不可であり、既存の互換一覧とnamespace/pathによる保存を確認する。
- 題材の異なる2件で実際の本文取得、タイトル・比較表・出典のあるMarkdown、一時ファイルとDoclingの本文一致、会話のspecialist sessionがないこと、Webでの文書表示を確認する。
- 第3の題材で調査中の取消と、取消後に文書・通知が追加されないことを確認する。設定変更を伴うDocling停止・容量不足・応答喪失は固定試験の結果と区別し、この環境へ故障を注入しない。
- 実行中は製品コードを編集しない。ここは検証の出力先であり、調査へ渡す入力ではない。

## 実行と観測

| ケース | 会話ID末尾 | 入口・結果 |
| --- | --- | --- |
| A: オフラインメモ用のブラウザー保存API | `-a` | 自然文のCLI chatから `web.research@6` が選ばれた。Pursuit `297cc0d4-4b18-4768-802e-04fe3240bbd5`。完了・両方の保存・本文一致・画面表示が成功 |
| B: 博物館2館の撮影ルール | `-b` | 自然文のCLI chatが `web.search@9` を選択。調査workerが45秒の期限で終了。文書保存へ到達せず。保存機能の成功とは数えない |
| B2: 同じ題材の担当指定入口 | `-b2` | 公開 `send --toolchain web.research` は `toolchain_unavailable`。既存のpinned入口はこのtask方式を対象にしない。起動しなかった |
| B3: 担当名と公式サイトを明示 | `-b3` | 自然文のCLI chatから `web.research@6` が選ばれた。Pursuit `649b2872-3c35-44a4-8f58-ec9a63e4513e`。完了・両方の保存・本文一致・画面表示が成功 |
| C: 自治体資料の調査を途中で中止 | `-c` | 自然文の中止指示は新たなPursuit依頼になり、元の調査は止まらなかった。既存TODOの公開archive操作で両方を取消。2分後の照会でも新規文書・通知・sessionは0件 |

会話IDはいずれも `research-md-live-20261108` で始まる検証専用ID。既存の利用者の会話や別Codexチャットへ入力していない。

## 取消の証拠

Cの開始runは `32c0cd66-f49f-4fc6-b4bf-4b7859572a49`、中止指示runは `be057369-4a6d-49d8-9879-b3d3d32d3e54`。前者のPursuitは `6f8eb7fd-71f9-413b-9b26-8052f7380d52`、中止指示で新たに作られたPursuitは `63b29ac5-1266-47ae-bba6-34d78b22d6cc`。

11:10:27–28 JSTに、当該会話のTODO2件だけへ `artifact:agency.todos@4` の `archive` を公開APIで送信。両方acceptedとなった。11:12:35 JSTの再照会でTODOはcancelled/archived、各Pursuitの最後のjobはcancelled、conversation resources・noticesはいずれも空、specialist sessionはnull。11:32:21 JSTにも同じ状態を確認した。別会話A・B3は取消の影響を受けず完了した。

`case-c-explicit-cancel.json` と `case-c-after-cancel.json` に結果を保存した。自然文の取消が成功したとは扱わない。

## 保存実体と画面

| 確認 | A | B3 |
| --- | --- | --- |
| 最終status | 完了 / succeeded | 完了 / succeeded |
| タイトル・本文 | 日本語見出し・比較表・限界・出典3件 | 日本語見出し・比較表・限界・出典2件 |
| scratchの実体 | `.md` / `text/markdown` / 4,688 bytes | `.md` / `text/markdown` / 2,535 bytes |
| Docling保存先 | namespace `eumenes` / path `research/2026-11-08_…_c8600344-ed9a-4ff9-b479-23ac5149a8bd.md` | namespace `eumenes` / path `research/2026-11-08_…_41163220-3c97-4577-a2ae-a0e635290ef4.md` |
| 保存結果の読戻し | scratchとDoclingの本文が完全一致、scratchのSHA-256・bytesも一致 | 同左 |
| 保存job | completed / 332 ms / attempt 1 | completed / 270 ms / attempt 1 |
| 依頼から通知まで | 1,435.4秒（約24分） | 1,171.1秒（約20分） |
| ブラウザー | `eumenes/research` 一覧・保存済み表示・Plate取込み、通知の文書リンクから開く操作が成功 | 通知の文書リンクから開き、タイトル・比較表・出典・保存済み表示を確認 |
| 担当切り替え | 検証会話と画面のmain会話でspecialist sessionはnull | 同左 |

2件を並行した時間を含む実測で、単独実行時の性能とは比較していない。保存処理自体の待ち時間は短く、所要時間の大半はPursuitの調査・執筆・検証と共有推論資源の待ち時間だった。設定や予算を増やす変更はしていない。

画面では利用者の既存会話へ発言せず、既存のミュート状態を維持した。通知から開く際の既読化とMarkdown workspaceへの通常の取込みだけを行った。取込み後もDocling本文と元の一時ファイルの一致を再確認し、文書の編集・再保存はしていない。[画面記録](case-a-editor.jpg)。

根拠は `summary.json`、各 `*-checks.json`、`*-scratch.json`、`*-jobs.json`、`*-result.json`、生成Markdown。`usage-observed.json` は最新100件の使用記録APIから対象の調査だけを抜いた観測値であり、全使用量の集計ではない。通常ログは秘密・本文・Provider生応答を含まない既存logger出力だけを `verification-reports/toolchain/web-research-markdown-live-backend.jsonl`（0600、ローカル専用）へ分けて保存する。

## 判断と残課題

合意済みの文書保存機能は、題材の異なる実接続2件で確認できた。実モデルが書いた内容を厳密な証明としては扱わないが、依頼された見出し・比較表・出典・不明点を持つ文書であることを確認した。Pursuit配布物や製品コードの追加修正は不要だった。今回の実行中も、固定検証後も、製品コードを変更していない。

自然文の中止が新規調査になること、複合依頼が通常検索へ選定されること、調査の所要時間が長いことは未解決の課題である。文書保存の成功によってこれらを成功扱いにせず、会話の共通選定・制御とPursuitの完了判断の別課題として残す。担当指定のpinned入口は既存仕様の対象外であり、対応追加は行わない。今回の検証は完了し、追加のモデル実行は行わない。サーバーは利用者が試せるよう起動したままにする。
