# Codex SDK・最小JSON・jsonrepairの合同レビュー（2026-10-11）

## 対象と完了条件

Lunaへ渡す定義・指示、SDKの完了応答、共通JSON補正、workerと会話の契約検証、失敗通知を一続きで確認する。最小のinvoke/finish形式を維持し、補正が値や実行権限を作らないこと、拒否理由を追えること、既存の取消・rollback条件を維持することを完了条件とする。部分試験、実SDKを用いる固定出力の結合試験、利用側7domain、固定snapshotの全体検証の順で確認する。

## 発見と修正

1. 共通処理が重複キーや危険な補正を拒否しても、workerが元の文字列を再度JSON.parseし、別の構文エラーで理由を上書きしていた。重複キー・値補完・深さ超過等の固定分類を優先し、警告とモデルへの修正資料へ保持するよう修正した。途中切断・通常構文エラーの既存の安全な詳細分類は維持した。
2. 会話function引数では補正拒否の分類が捨てられ、arguments_not_jsonだけになっていた。既存の公開コードを維持したままvalidationPath=argumentsと共通処理の固定コードを、警告と一回のモデル修正資料へ渡すよう修正した。
3. 共通処理に拒否ログを追加した最初の版はwarnを直接出していた。正式なagent-runtime検証で、保存のrollback時にも警告が残るという新しい回帰を検出した。共通処理はdebugの構文観測に変更し、採用・保存後に確定する既存domainのwarnを処理結果の正本とした。既存のrollback試験は変更せず、修正後に合格を確認した。初回不合格の結果はagent-runtime-before-debug-fix.jsonに保存した。

補正処理は引用符・カンマだけを補う。値、型、キー、コロン、括弧の変更は採用しない。重複キー、途中切断、欠落値、複数JSON、前後の説明文を拒否する。schema・公開ツール・権限・根拠・期限・取消の検証は補正後も既存機構で行う。新しい意味判断・語句別分岐・推論ループは追加していない。

## 検証の経過

- 修正前の関連既存試験：108成功、0失敗。
- 診断欠落を再現する追加試験：45成功、3失敗。修正後は111成功、0失敗。
- SDK結合試験：15成功、0失敗。実際の@openai/codex-sdkと固定応答ランタイムを使用し、構文補正後の検索・終了、重複actionの拒否、未提供ツールの拒否、未取得根拠の拒否を確認した。拒否時は検索0回、一回だけモデル修正を試みて停止する。既存のSDK失敗分類試験も含む。
- rollback対応後の部分・結合試験：53成功、0失敗。従来の保存・取消ログ試験を含む。
- SDKから共通補正とhost拒否までの追跡：integration-trace.json。共通拒否2件と確定したhost拒否2件のjobId一致、親runIdへの接続、検索0回、生応答をログへ保存しないことを確認した。
- 固定snapshotの型検査：成功。別作業の以前の記録にある音楽UIの型エラーは、このsnapshotでは再現していない。
- 利用側7domain：inference、agent-runtime、dialogue、coding-supervision、music、voice-dialogue、worldがすべて合格。各結果は対応するdomain名のJSON。
- 全体検証：不合格（all.json）。バックエンド1539成功・1skip・0失敗、Web304成功、client329成功。design-system専用型検査で音楽UIのMusicCreationForm.test.tsxのexactオプションがByRoleOptionsに存在しないという型エラー6件が発生して停止した（20/23/42/49/60/83行）。JSON補正・SDKの変更範囲外なので修正していない。後続のdesign-system試験・browser試験はこの通し実行では未実施。全体合格の続行条件は、音楽UI側でこの型エラーが解消した後の固定snapshot再検証。
- 開発サーバー：実行待ち・実行中ジョブ0件を確認して通常終了・再起動。認証付きAPIとWebが200応答（runtime.json）。

## 検証の範囲

inputs.jsonの固定snapshotを隔離worktreeで検証する。製品DB・設定・秘密をコピーせず、固定lockで依存を導入した。入力のコピー中の変化は0件。音楽/UIなど着手時からの並行差分は、利用側の検証入力として含め、今回の修正の成果には数えない。

今回は固定された不正出力の再現が目的であり、外部Providerへの新しいlive試験や実音声機器の受入は行わない。先の実Luna試験は../codex-sdk-2026-10-11/record.mdに別記している。元の障害のstderrは残っていないため、JSONの複雑さが当時の原因だったとは断定しない。

SystemContextのcontext_compileとcompile_evalはこの合同レビューで各1回。コード差分にユーザーの語句・個別シナリオ専用の意味判定は追加していない。

最終差分点検：git diff --check成功。検証snapshotの変化0件。作業フォルダとの差は並行作業のMusicCreationForm.css、MusicCreationForm.tsx、scripts/music-creation-ui-check.tsの3件だけで、レビュー対象のSDK・指示・JSON補正・診断・回帰試験は検証版と一致した（final-input-check.json）。これらの並行差分を変更・削除していない。
