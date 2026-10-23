# 画面フォームからの依頼を画面の担当へ直接渡す設計（2026-10-23）

状態: 合意済み・実装・固定試験済み（§8）。ブラウザE2E・live・実機器は未実施。

## 1. 背景

画像生成の画面（`image-screen` artifact）で「生成」を押すと、画像ではなく曲が作られて失敗した（run `5b08cd43-dd5b-4247-91c6-df120e655a2b`、2026-10-23 22:54〜22:56 JST）。

- 画面のフォームは `POST /api/runs`（`client.submit`、`presentation: "artifact"`）へ自然文を送る（`web/src/domains/image/use-image-creation.ts`）。楽曲生成の画面も同じ（`web/src/domains/music/use-music-creation.ts`）。
- そのため、利用者がAIに話しかけていなくても、メインエージェントが通常の発話と同じ手順で担当を選ぶ。最初の提示はこの会話で使用済みの担当だけで（`retainedCandidates`）、このときは `compute.python`・`music.create`・`weather.forecast` の3件だった。`image.create` は無く、モデルは `find_toolchain` を呼ばずに `music.create` を選んだ。
- `music.plan`・`music.generate` が実行され、その後の完了確認の推論が `chat_stream_incomplete` で失敗し、run は `permission_revoked` で終わった。

画面は自分の担当が決まっている。画面からの依頼を、担当の選択に任せる理由は無い。

## 2. 方針

画面フォームの送信は「その画面の担当への依頼」として受け付ける。メインエージェントの担当選択（使用済み担当の提示・`find_toolchain`・依頼の分析）は行わず、指定の担当の専門エージェントへ依頼文をそのまま渡す。

- 画像: `image.create` の専門エージェント（`image.plan` → `image.generate`）。
- 楽曲: `music.create` の専門エージェント（`music.plan` → `music.generate`）。
- 依頼は会話のrunとして残す。受付・進捗・取消・画面への結果表示・完了後の返答は既存の経路のまま変えない。
- 指定の担当が無効・利用不可なら、そのrunは `toolchain_unavailable` で失敗させる。メインエージェントの選択へ切り替える代替経路は作らない。

## 3. 契約

### 3.1 送信（`POST /api/runs`）

`submitFields` に任意の項目 `toolchainId`（担当のID、`/^[a-z0-9][a-z0-9.-]{0,63}$/`）を追加する。

- `toolchainId` があるときは `presentation: "artifact"` を必須とし、`attachmentIds` は付けられない（専門担当へ添付を渡す経路が無いため）。違反は既存の検証失敗と同じ 400。
- 冪等性: 同じ `requestId` の再送で `toolchainId` が異なれば、既存の項目と同じく `request_conflict`。
- 声のrun（`utteranceId`）・通知・継続・予定の入力には使わない（内部の `submitSchema` も `utteranceId` との併用を拒否する）。

### 3.2 保存

runに `pinned_toolchain_id TEXT NULL` を追加する（名前付きmigration `dialogue/0016-pinned-toolchain`、`after` は 0015）。受付時に保存し、冪等性の比較と生成時の分岐はこの値を読む。

### 3.3 Web

- 画像の画面は `toolchainId: "image.create"`、楽曲の画面は `toolchainId: "music.create"` を付けて送る。
- 依頼文はフォームの値から作る今の文面のまま送る（制作プロンプト・幅・高さ・形式・シードを専門エージェントが読む）。

## 4. 生成時の処理（dialogue）

`dialogue.generate` の実行で、runに `pinned_toolchain_id` があるとき:

1. `analyzeInitialRequest`（使用済み担当の提示・分析・`find_toolchain`）を呼ばない。モデルの呼び出しは無い。
2. 担当の現行revisionを解決する。`routing.available` に無い、現行revisionが無い、または実行種別が `image`・`music-create` 以外なら、`toolchain_unavailable` でrunを失敗させる。選択記録は作らない（選択をしていないため）。warnログ `dialogue.pinned_toolchain_unavailable` に担当IDだけを残す。
3. 選択記録（`toolchain_selections`）を `decision: "toolchain"`、`retrieval: "none"`、候補はその担当1件、依頼文は送信本文で残す。記録だけで新しい判断はしない。
4. `ConversationOperation`（`functionName`・`revisionId`・`request` = 送信本文）を作り、既存の `settleConversationOperation` へ渡す。推論のreceiptは無い（`operationRejection` は receipt 無しで記憶・目標の鮮度だけを確認する）。
5. 専門エージェントの完了後の再入では、依頼の達成の確認（`completionCheckInTransaction`）をしない。画面は担当と一回の生成を指定しており、続きの手順を判断する対象が無いため。
6. その後の経過は今と同じ。専門エージェントの完了で既存の結果の返答の生成が続き、画面には `presentation: "artifact"` の短い返答方針が使われる。使用済み担当への登録（`retainAdopted`）も今と同じで、以後の発話でもこの担当が最初の提示に入る。

このファイルの予算（関数300行・ファイル800行）を保つため、分岐は `generation-handler.ts` に入れず、新しいファイル `pinned-operation.ts` に置いて呼ぶ。

## 5. 変更しないもの

- 発話・声からの依頼の担当選択（`retainedCandidates`・`find_toolchain`・分析）。
- 画像・楽曲 domain の計画・生成・取消・削除。
- 画面の定義（bundle）。画面の担当IDはWebの画像・楽曲の画面用hookが持つ（どちらも既に画像・楽曲専用のhook）。

## 6. 試験

- dialogue: 指定ありのrunで、分析・選択の推論を呼ばずに `image` / `music-create` の開始が呼ばれる。利用不可・現行revision無し・対象外の実行種別で `toolchain_unavailable`。`toolchainId` だけ違う再送で `request_conflict`。`presentation` が無い・`conversation` の指定ありで `400`。
- 結合: `api/application/media/image-e2e.test.ts`・`music-e2e.test.ts` に、使用済み担当に別の担当だけがある会話で画面から送っても画像・楽曲が生成されるケースを追加する。
- Web: `use-image-creation`・`use-music-creation` が `toolchainId` を付けて送る。
- 確認: `bun run verify -- --domain dialogue --domain image --domain music`。

## 7. 範囲外（別件）

- `GET /api/images/library` が常に 502（LARMの画像一覧の失敗。catchがエラーを捨てるためログに原因が残らない）。
- `GET /api/music/tracks`・`/tags`・`/providers` の 500（`errorFrames` が空）。

## 8. 実施記録（2026-10-23）

実装:
- 契約: `api/domains/dialogue/contracts/index.ts`（`toolchainId`、`pinnedToolchainId`）。
- 受付: `api/domains/dialogue/service/intake.ts`、`repository/index.ts`（migration 0016、`savePinnedToolchain`）。指定ありの送信は専門セッションに渡さない。
- 生成: `api/domains/dialogue/service/pinned-operation.ts`、`generation-handler.ts` から呼ぶ。結果の返答のための再入（`mediaResult`・`operationResult`・`agent`）では指定経路を通らない。
- Web: `use-image-creation.ts`（`image.create`）、`use-music-creation.ts`（`music.create`、あわせて `presentation: "artifact"`）。

固定試験: `bun test api/domains/dialogue api/domains/image api/domains/music api/application/media` 615 pass、Web の image・music 24 pass、typecheck・format・lint 通過。`verify --domain dialogue --domain image --domain music` は、本件と無関係な既存の size-budget（`generation-prepare.ts#createPrepare` 307行、62e91216 から）で止まる。

既知の制約（low、2026-10-24レビューで解消）: 指定ありのrunでも prepare が使用済み担当を準備していたため、無関係な担当の現行revision消失で`toolchain_context_stale`になりえた。指定済みrunではその準備を省くよう修正した。

### 8.1 追記（2026-10-24）: 生成後に失敗が表示された件

実機で画像は生成されたが、画面に「画像を作成できませんでした」が出た（run `9b533638-e5c1-4ad2-b66a-170e86c4736a`）。

- 結果の返答の再入で完了確認（`judgeCompletion`）が走り、推論が `chat_stream_incomplete` で失敗した（出力上限 1536 tokens での打切りとみられる）。
- 完了確認は返答と同じ推論リクエストを使う。推論の失敗でそのリクエストが `failed` になり（`inference/service/execute.ts`）、続く返答の生成が `permission_revoked` で拒否され、runが失敗した。

対応: 画面フォームの依頼は完了確認の対象から外した（§4-5、`completion-check.ts`）。結合試験 `image-e2e.test.ts` は、完了確認が呼ばれたら失敗する形にした。修正を外すと失敗し、修正ありで通ることを確認した。

2026-10-24レビューで対応: 完了確認の失敗が声・会話の返答まで失敗させる問題も、共有executorの非表示auxiliary呼出しで修正した。公開APIからの回帰試験と制約は[レビュー記録](verification/code-review-2026-10-24.md)を参照。
