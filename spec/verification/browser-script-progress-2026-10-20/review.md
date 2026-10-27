# ブラウザScript・進捗UIのコードレビュー

2026-10-20。対象は今回の未コミット実装と、その実行・表示に直接関係する既存処理。設計書、LLMへの指示、共通エージェント核、browserのtask・operation・capture台帳、Bridge設定、登録bundle、Web・DesignSystemを照合した。製品設定とサーバーは操作していない。

## 修正した指摘

| 優先度 | 問題と再現条件 | 修正と確認 |
| --- | --- | --- |
| P1 | taskを撮影の変換中に中止してもcaptureが終了せず、遅い画像が`local_ready`として保存される | task終了の同じwriterで子captureを終了し、実行中の撮影にも取消を伝える。queueの処理終了まで待ち、画像が残らないことを確認 |
| P1 | Bridge credentialの改訂が進んだ直後、非同期切断が完了する前に古い接続の画像を保存できる | 撮影の実行・保存段階でも接続、task、Scriptの現行性を検査する。変換中の失効とScript改訂を再現し、保存拒否と一時ファイル削除を確認 |
| P1 | 同じ失効タイミングで届いた操作応答が、成功結果やタブのtitle等へ採用される | operationの結果保存時にも既存の接続検査を使う。古い応答を採用せず、送出済み操作は結果未確定として記録し、自動再送しない。取消前に送出され、失効せず確認できた操作を記録する従来契約は維持 |
| P2 | 再接続してもタブqueryのキーが同じため、前のsessionのタブが表示される | connection IDでqueryを分け、操作可能な接続のときだけ読み取る。接続IDの変更後に新しいタブ一覧が直ちに取得されることを確認 |
| P2 | 「接続・タブ」等へ移動するとScript部品が破棄され、選択したtaskと開いた履歴がリセットされる | 既存ArtifactPanelと同じforceMount・hiddenの方式でScript部品を保持。補助タブから戻っても選択と展開状態が残ることを確認 |
| P2 | Script公開の応答に全改訂履歴を含め、更新のたびに同じ過去の計画を推論履歴へ重複保存する | 推論への応答は現行のScriptだけにする。画面用の改訂履歴は台帳に維持する。応答にhistoryがなく、保存履歴は失われないことを確認。推論回数・容量の上限は変更していない |
| P2 | 全会話の直近20件を取得してからWebで絞るため、他の会話の作業が増えると現在の会話の履歴が消える | owner・conversationで先に絞る既存list操作を追加し、認証済み読取APIから取得。21件以上の別会話と別ownerのtaskを用意し、自分の会話の履歴だけが返ることを確認 |
| P2 | 「実行中」だけで、設計にある推論・接続・観測・操作の段階を区別できない | hostの実際の処理開始箇所でphaseを保存し、同じsource・propsで表示。時刻や語句から推測しない。推論と操作中の保存状態、終了・取消後に古いphaseを表示しないことを確認 |

主要変更は [capture-run.ts](../../../api/domains/browser/service/capture-run.ts)、[lifecycle.ts](../../../api/domains/browser/service/lifecycle.ts)、[operation-settle.ts](../../../api/domains/browser/service/operation-settle.ts)、[task-api.ts](../../../api/domains/browser/service/task-api.ts)、[use-browser-runtime.ts](../../../web/src/domains/browser/use-browser-runtime.ts)、[BrowserWorkspace.tsx](../../../packages/design-system/src/components/BrowserWorkspace/BrowserWorkspace.tsx)。

phaseの保存と会話別の取得用indexは、追加migration `browser/0004-progress` に置いた。既存migrationと登録済みbundleは書き換えていない。会話別の読取は `GET /api/browser/tasks?conversationId=…` を使い、ownerは認証済みのhost側で固定する。

## 反復レビュー

1. 取消・撮影失効・キャッシュ・閲覧状態・推論履歴について、現状で失敗する回帰試験を用意してから修正した。
2. 複数会話の取得順序と、設計に対する実行段階表示の不足を確認し、修正・検証した。
3. 結果の採用箇所を再確認し、失効後の操作応答の採用を追加で再現して修正した。
4. 修正後に接続・取消・Script改訂、秘密の扱い、登録・移行、画面の接続を再レビューした。今回の対象で追加の具体的な修正指摘は見つからなかった。

途中の検証で新規テストの型指定に不備があり修正した。期待値・容量上限・依存境界を弱めて検証を通す変更はしていない。3ラウンド後は、再現できた問題が減っていることと新しい失効経路の証拠を確認し、修正継続から最終検証へ移った。

## 最終検証

- `bun run verify -- --domain browser --domain capabilities --domain tool-runtime --domain inference --domain dialogue --domain voice-dialogue --domain delivery`：成功。Bun 998件、Web 84件、DesignSystem 28件。format・lint・依存境界・SystemContext・容量・型・DesignSystem buildを含む。
- `bun test api/application/browser api/domains/browser/test api/application/migrations.test.ts`：255件成功。application/browser 83件、browser domain 151件、migration 21件。
- `bunx playwright test tests/browser/browser-workspace.spec.ts`：320/420/700pxの3件成功。サーバーなしの既存ArtifactPanel受入。
- 全体型検査：2,222ファイル成功。Web build：成功。既存のchunk等の警告は残る。
- `git diff --check`：成功。新しいモデル・profile名、発話や特定サイトによる意味判定、別planner、自動再送は追加していない。main上の着手前の変更を維持した。

verify記録: `spec/verification/reports/runs/2026-10-20T14-37-35-041Z-86cf51a8-f3f4-40c8-aa39-4057439c9626/report.json`。検証中に製品コードを編集していない。

[初回実装記録](README.md)にある担当外の既存検証エラー、および実Brave/Bridge・実LLM・ASR実機の未受入は別に残る。固定試験の成功や今回の再レビューを、これらの確認完了とは扱わない。

contextStill: 今回context_compile・compile_eval各1回。会話累計は各6回。
