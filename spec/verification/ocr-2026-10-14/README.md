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

ブラウザ試験は固定 gateway 応答と Chromium を使用する。実 gateway、MacBook の物理カメラ、再起動後の実環境での受入は未実施。標準の `verify --domain ocr` は OCR の size・format・lint を通過した後、共通 Button 部品の `@/utils/cn` を選択型チェック用設定が解決できず停止した。全体型チェックは並行作業中の `tests/browser/object-recognition.spec.ts:265` の型エラーで停止した。これらの担当外のファイルは変更していない。
