# 物体認識画面の登録・表示確認（2026-10-14）

## 範囲

既存の会話用 `object-recognition.manage@1` は維持し、画面を `object-recognition-screen.bundle.json` の単独公開 artifact `object-recognition.workspace@1` に移した。backend と Web の登録 adapter が履歴 source と既存の認証済み操作を接続する。DesignSystem の画面はアーティファクト枠内で、左にカメラ・結果、右に撮影・録画と検出物を配置する。幅が狭い場合は縦に並ぶ。

## 確認結果

| 対象 | 結果 |
| --- | --- |
| bundle の登録検査 | 成功。登録可能、既存登録と同一内容 |
| 登録・API 結合 | 3 成功。二重登録なし、所有者 scope の source、認証付き入力から会話追加まで |
| DesignSystem | 7 成功。検出枠・動画時刻・取消後の非表示・カメラ解放・認証方式・送信中から解析完了までのボタン表示。ビルド成功 |
| 物体認識 domain gate | 成功。backend 10、Web 2 成功 |
| capabilities / artifact gate | 両方成功。登録基盤 63、アーティファクト 44 成功 |
| 登録基盤の直接試験 | 64 成功 |
| artifact / launcher / Web runtime の直接試験 | 53 成功 |
| ブラウザ fixture | 2 件を同時実行して成功。登録メニュー、枠内の左右配置、画像、仮想カメラ撮影、録画、動画 seek、解析中ボタンのインジケーターと `aria-busy`、取消後の消灯、会話追加、再読込、狭い表示を確認 |
| 全体型チェック / Web ビルド | 成功。1,379 ファイルの型チェックと production build |
| 差分 | `git diff --check` 成功 |

ブラウザの動画試験には、FFmpeg で作った 2 秒の単色図形 WebM (`tests/browser/fixtures/object-recognition-2s.webm`) を使う。ブラウザの `MediaRecorder` でその場で作る短い WebM は、実行ごとにシーク可能な長さが変わり、時刻ボタンの試験が不安定だった。録画操作そのものは別の仮想カメラ試験で確認した。

最初の `capabilities` / `artifact` gate は並行作業の書式差分で停止したが、その差分が解消された後に両方通過した。物体認識 gate の一度目の最終実行は並行作業による入力 hash の変化で無効になった。入力が落ち着いた後の再実行は通過した。担当外の差分は変更していない。ブラウザは fixture と Chromium の仮想カメラであり、物理カメラと実 gateway の新画面での受入はこの記録に含めない。

解析中ボタンの表示を追加した後は、DesignSystem の 7 試験とビルド、ブラウザの対象 2 試験、差分確認が成功した。物体認識 gate の再実行は、並行作業中の `packages/artifact-ui/src/ui-composition-components.tsx` が参照する `lucide-react` の解決エラーで型チェックが停止した。対象画面の試験結果と、この未完了の全体確認は区別する。

資料一覧を左上のメニューに移した後は、DesignSystem の 9 試験とビルド、物体認識 gate（backend 10・Web 2）、artifact gate（44）が成功した。ブラウザは対象2試験をそれぞれ明示実行して成功。履歴の開閉・選択、終了した資料の確認付き削除、削除後の一覧反映、録画資料の表示、狭いアーティファクト枠を確認した。解析中の資料は既存API契約に合わせて削除不可とした。

履歴から元の画像・動画を復元する変更では、保存済み入力を解析状態にかかわらず読み込み、解析結果のない資料も元のメディアを表示する。検出枠は完了済みの結果に限る。履歴選択時にカメラを閉じて資料表示へ切り替え、録画中は資料一覧を開けない。DesignSystem 10 試験、Web runtime 2 試験、DesignSystem ビルド、物体認識 gate（backend 10・Web 2）が成功。ブラウザ fixture ではキャンセルした動画を再読込後の履歴から選び、シーク可能な元動画の再生とカメラからの切り替えを確認した。録画中に資料一覧を開けないことも別のブラウザ試験で確認した。artifact gate は並行作業中の `terminal-components.tsx` の lint エラーで停止し、対象変更の検証とは区別する。

## 画面

- [動画の時刻別検出と右側の物体一覧](artifact-video.png)
- [解析中のボタンと進捗表示](artifact-running.png)
- [左上メニューの資料一覧と削除操作](artifact-history.png)
- [狭いアーティファクト枠での縦配置](artifact-narrow.png)
