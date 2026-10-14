# OCR アーティファクト実装確認（2026-10-14）

## 実装範囲

`ocr-host` の画像・動画 OCR を、保存原本、状態照会、取消、会話追加まで OCR domain に接続した。会話用 profile・Skill・tools と、`ocr-media` / `ocr-panel` の画面を版付き bundle と登録 adapter から公開する。ファイル選択はアイコンボタン。履歴は保存原本の再表示、画面内サムネイル、状態、確認付き削除を扱う。

## 固定試験

| 対象 | 結果 |
| --- | --- |
| OCR domain・HTTP・command adapter | 7 件成功。画像・動画、原文と polygon、所有者境界、再送防止、取消後の遅い結果を確認 |
| bundle 検査 | 成功。`ocr.workspace@2` と `ocr.command@2` の参照を確認 |
| ブラウザ fixture | 1 件成功。アイコンから画像を選択し、行と polygon、会話追加、保存資料3件の画像・動画サムネイル、履歴選択、動画時刻を確認 |
| 既存機構の回帰 | 88 件成功。capabilities、migration、設定、物体認識 adapter を確認 |
| 境界・書式・lint・Web ビルド | 成功。`git diff --check` も成功 |

## 追加レビューと修正

履歴100件より前に残った処理中の資料も数えるようにし、同時処理の上限を保存全件に適用した。接続先の変更後は状態再確認を拒否し、画面の再確認ボタンも隠す。削除した資料の原文が OCR 操作結果に残らないようにした。受付IDを再送した場合は接続設定がなくても既存の受付を返す。画面では行一覧とは別に OCR の全文を表示する。資料切替後の時刻・行操作には資料IDを付け、別の資料への誤適用を防ぐため、bundle の Artifact・binding・toolchain を revision 3 にした。会話の8000文字上限を超える全文は追加前に拒否し、行選択を案内する。

| 対象 | 結果 |
| --- | --- |
| OCR domain・HTTP・command adapter | 12 件成功。100件超の履歴、接続変更、削除後の操作結果、受付再送、会話の文字数上限を追加確認 |
| capabilities の bundle・Artifact 回帰 | 36 件成功。revision 3 の登録と参照も検査成功 |
| ブラウザ fixture | 1 件成功。全文表示と既存の画像・動画操作を確認 |
| SQL 境界・書式・lint・Web ビルド | 成功 |

`verify --domain ocr` は OCR の size・format・lint を通過した後、共通 Button の `@/utils/cn` を選択型チェック用設定が解決できず停止した。全体型チェックは担当外の `tests/browser/object-recognition.spec.ts:265` で停止した。DesignSystem 単独ビルドでは194ファイルの型チェックが成功した。実 gateway と物理カメラは未検証。
