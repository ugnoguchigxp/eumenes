# 計画3　Web・音声・検証　検証記録

2026-11-17。基準コミットは `204280c675cc67809ddf1cd1ab623e4243d06a5e`。作業は main。`initial_instructions` はこのセッションのツール一覧に無く、実行していない。サーバーの起動・停止、製品DB、実接続、実機器の再生は行っていない。`scripts/bundle-budget.json`、`scripts/size-budget.json`、`bun.lock`、CIワークフローは変更していない。

初回JSの計測は、独立コピー `/Users/y.noguchi/Code/eumenes-plan3-verify-2026-11-17`（`git checkout --detach` で基準コミット、元checkoutのindexは更新していない）で行った。Bun 1.4.4、Darwin arm64。gzip は `scripts/bundle-budget.ts` と同じ level 9。公式の容量は source map なしのビルド。DesignSystem の `dist` はコピー内で作り、製品DBと秘密は複製していない。

## 初回JavaScript

記録済み予算は entryGzip 112,035 B、initialGzip 259,653 B。許容は 2% で、初回合計の上限は 264,846 B。対象は `dist-web/index.html` の module エントリと、すべての `link rel=modulepreload`。

| 条件 | エントリ | 画面観測名のチャンク | 初回合計 | 上限 |
| --- | --- | --- | --- | --- |
| 基準コミット、source map なし | 52,098 B | 139,451 B | 399,146 B | 264,846 B |
| 評価時の記録 | 52,092 B | 139,453 B | 399,147 B | 同じ |
| adapter を開いたとき読む形にした後 | 52,840 B | 先読みから外れた | 343,662 B | 264,846 B |

基準の `bundle:check` は `initialGzip: 399146 B exceeds the recorded 259653 B (limit 264846 B)`。評価との差は 1 B 前後で、コミットと gzip 方法は同じ。基準ビルドの大きい先読みは react 55,755、radix 44,237、zod 43,952、query 25,799、Button 10,911、location 8,342、audio 8,326、background 3,690。分割後のエントリは `assets/index-DhgNdhN_.js`。

画面観測名のチャンクは、観測hook自身ではなく、全Web adapter と client の静的importが一つの先読みにまとまったものだった。adapter は `adapterRef` ごとの動的 `import()` に分け、開いている toolchain タブだけを読む。ホストは既存の「画面を読み込んでいます」を、domain の画面モジュールが来るまで出す。登録の無い ref は従来どおり generic。別の状態台帳は作っていない。

分割後も `initialGzip: 343662 B exceeds the recorded 259653 B (limit 264846 B)`。減ったのは 55,484 B。上限までは約 78,816 B 足りない。残る大きい先読みは react 55,755、エントリ 52,840、radix 44,237、zod 43,952、query 25,799、client 20,744、契約 12,115、Button 10,911、toolchain-artifacts 10,826、audio 7,826。react、radix、zod の2系統、query、エントリだけで約 222,583 B。上限に収めるには残りの先読みが 42,263 B 以下である必要があり、実際は約 121 KB ある。

検証コピーで、manualChunks から zod と radix を外すと 335,435 B、client の artifact 専用分を静的importから外すと 332,752 Bだった。どちらも上限を超える。両方とも計測後に戻した。`client/index.ts` は計画3の書き込み範囲外で、会話・音声・通知が初回画面から使う client は先送りできない。既定画面がすぐ読むコードを、数値を通すためだけに動的importへは移していない。

この 343,662 B は adapter 分割までを含む。その後の `DebugDiagnostic.tsx` と `MessageList.tsx` の変更はエントリに入り、再計測していない。上限内とは扱わない。初回入力、画面観測、アーティファクトを初めて開く操作、マイク開始、音声表示の所要時間は測っていない。

## ID

| ID | 状態 | 結果 |
| --- | --- | --- |
| 3-01 | 評価済み | 上表。基準 399,146 B、上限 264,846 B。評価との差は 1 B 前後。 |
| 3-02 | 分割したが未達 | 開いた画面の adapter だけを読む形にした。既定画面の単体試験は通る。初回合計は 343,662 B で上限を超える。ブラウザーでの初回操作は未確認。 |
| 3-03 | 未計測 | gzip の前後は上表。初回入力とアーティファクト初回操作の時刻は未計測。 |
| 3-04 | 未再現 | 保存通知の連続再取得は、サーバーを起動せず測っていない。調整は入れていない。 |
| 3-05 | 未実施 | 再接続と取得競合は未試行。 |
| 3-06 | 未実施 | 会話スクロールの回帰は未実施。 |
| 3-07 | 未実施 | キーボードと状態区別は未確認。 |
| 3-08 | 修正済み | 描画中の `Date.now()` をやめ、期限は描画前の effect で見る。既に期限切れ、期限到達、項目の入れ替えを fake clock で確認。詳細取得と期限後の非表示は維持。ContextWindow は触っていない。 |
| 3-09 | 修正済み | 会話描画は表示用のローカル型、client は lease のローカル型。公開契約の深いパスは外した。境界検査は両方とも指摘なし。`AgencyActivity` は Dialogue の公開 contracts に無く、そちらは変更していない。 |
| 3-10 | 未実施 | ASR の遅延・切断・手修正は未試行。 |
| 3-11 | 未実施 | 句の読み上げと受領の追加照合は未実施。既存の音声固定試験は下の通り成功。 |
| 3-12 | 未実施 | 区間遅延は未計測。本文と音声は記録していない。 |
| 3-13 | 未実施 | 実機3往復は許可と利用者の確認が無い。音声MVPは未受入。 |
| 3-14 | 未実施 | Live 音声の受入は未実施。 |
| 3-15 | 修正済み | `packages/` 以外で `package.json` と `api` と `web` を持つディレクトリを棚卸しの走査から外す。製品の Bun・Web・client・DesignSystem の試験と、コピーの外に置いた新しい試験ファイルは残る。実リポジトリの棚卸しに `artifacts/pursuit-` の試験は残らず、`api/domains/dialogue/test/pursuit-result.test.ts` は残る。 |
| 3-16 | 未実施 | 検証コピーの入力hashと出力hashの前後一致は未確認。 |
| 3-17 | 索引のみ更新 | 計画1から新しい `integrationTests` は無い。計画2からの追加パスも無い。生成表を `scripts/domains.ts` に合わせ、`--check` は成功。 |
| 3-18 | 修正済み | `docs/verification.md` は、手動起動のCIが全件を実行し、push と PR では起動しない、と現行の `workflow_dispatch` に合わせた。README は基準コミットと、Router 行の実モデル受入を今回更新していないことを書いた。ワークフローファイルは変更していない。 |
| 3-19 | 未実施 | 3担当の記録は揃ったが、取り込んだ1つのコミットでの再確認は未実施。 |
| 3-20 | 未実施 | 初回導入の手順計測は未実施。 |
| 3-21 | 修正済み | `respond.ts` の読み上げ購読を `watchSpokenAnswer` に分けた。分割前は `createVoiceResponder` が 342 行、内側の関数が 316 行で size-budget が失敗した。分割後は `size-budget ok`。録音開始、割込み、失敗、記録の順序は変えていない。試験の辞書参照は、公開入口のまま `voice-dialogue` の試験専用依存に `tts-dictionary` を足した。製品の api 依存は変えていない。 |

## 実行した固定試験

サーバー待受は作っていない。成功。

```text
bun test ./scripts/bundle-budget.test.ts ./scripts/verification-selection.test.ts ./scripts/verification-inputs.test.ts
bun test ./api/domains/voice-dialogue/test/routed-voice.test.ts ./api/domains/voice-dialogue/test/streaming-speech.test.ts ./api/domains/voice-dialogue/test/run-speech.test.ts
bun x --no-install vitest run web/src/queryKeys.test.ts web/src/workspace/DebugDiagnostic.test.tsx web/src/domains/voice-dialogue/test/input-session.test.ts
bun x --no-install vitest run web/src/workspace/toolchain-adapters.test.ts web/src/workspace/useCurrentViewing.test.tsx web/src/domains/toolchain-artifacts/launcher.test.tsx web/src/workspace/useSpecialistWorkspace.test.tsx web/src/components/domains/conversation/MessageList.test.tsx
bun scripts/size-budget.ts api/domains/voice-dialogue/service/respond.ts
bun scripts/domain-docs.ts --check
```

件数は、script 試験 10、音声試験 26、計画記載の Web 試験 9、adapter と会話表示の追加試験は先の実行で 6 ファイル 51（うち shell の既存失敗は下に記録し、その後の診断・adapter 再実行は 5）。size-budget は対象1ファイルで成功。

`pipelines` の選択試験が期待していた2ファイルは、基準コミットの時点で `workflow-authoring.test.ts` の登録と、pipelines を import する app-development の2試験が加わり5ファイルだった。期待リストをその5ファイルに合わせた。選択の規則は変えていない。

`web/src/workspace/shell-artifact.test.tsx` は、今回の adapter 読み込みの前から、モック応答が `sessionsSchema` の `approvals` を満たさず phase が `error` になる。HEAD の試験ファイルと adapter に戻しても同じ箇所で失敗する。今回の差分では直していない。

## 未実行

`bun run verify -- --domain conversation --domain dialogue --domain voice-dialogue --domain audio --domain live-voice`、`bun run build:web` の元checkoutでの再実行、`bun run bundle:check` の再計測、ブラウザーE2E、通常音声の実機、Live 音声は未実行。domain verify は起動を含む試験があり得るため、許可の前には実行していない。元checkoutで Web をビルドすると、他作業と共有する DesignSystem の `dist` を更新する。

`git diff --check` は、今回編集した Web・client・音声・検証script・文書について指摘なし。

## 他担当から受け取ったもの

計画1の記録は、新しい試験ファイルは無く、`api/application/pipelines/pipeline-execution.test.ts` は登録済み、と書いている。追加はしていない。

計画2の記録が渡しているのは、backup-restore の動的 import、Collaboration から Queue への依存、Pursuit の SQL 検査の3件。どれも `integrationTests` の追加ではなく、境界と SQL の共通設定に触る。この計画では登録も allow も変えていない。

## 残すもの

1. 初回JSは 343,662 B で、上限 264,846 B を超えたまま。音声MVPの実機3往復は未受入。
2. `AgencyActivity` を client と会話描画で共有するなら、Dialogue の公開 contracts から出す必要がある。今回の表示と lease はローカル型で足りている。
3. 3-04 以降の評価項目、実機、Live、統合コミットでの 3-19 は未実施。
