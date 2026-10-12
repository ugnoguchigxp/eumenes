# 設定画面の見本と再現条件

状態は設計資料。製品への移行は未実装。画像を掲載したことを、既存機能の完成・受入や画面案のユーザー承認と扱わない。

[画面見本のPage](https://chatgpt.com/space/page_4df1f952cea88191b54f5efa31c0d0aa)と[登録・保存先のPage](https://chatgpt.com/space/page_2755c0e6251c8191ac67f819f021177c)に保存した。PagesのFilesへ画像をアップロードし、返された永続画像参照を本文へ挿入している。

## 現行画面を再現するもの

| 対象 | 再現元 | 維持するもの |
| --- | --- | --- |
| サービスを試す | service-tests-current.jpg、service-tests-detail-current.jpg | 接続選択と自己診断、検索可能な一覧、対象別入力・結果、取消、履歴、保存と再取得。自己診断成功と実生成成功を分ける |
| 読み方辞書 | dictionary-current.jpg、web/src/domains/tts-dictionary/index.tsx | 文字・読み方・削除の表を横に3列。画面高さで行数を調整。空行へ直接入力、検索、上部保存と状態、件数、ページ送り、行を離れた際の保存、IME中を除くEnter、競合処理 |

これらの現行画面の本文と操作を維持し、目的別アーティファクトに接続する。現行の設定サイドバーまで新しいアーティファクト内へ複製する意味ではない。辞書の新しい生成画像は却下済みで、再現基準に使わない。

## 今回残す生成見本

| 画面 | ファイル |
| --- | --- |
| 薄い設定入口 | settings-hub-v3.png |
| 会話 | conversation-v2.png |
| 表示 | appearance-v2.png |
| 音声と入力 | voice-input-v2.png |
| AIと接続 | ai-connections-v2.png |
| 記憶 | memory-v2.png |
| 記録 | records-v2.png |
| 変更一覧 | changes-v2.png |

外観と密度の見本であり、項目、型、保存先、API、操作、未提供機能の有無は[全体設計](../../settings-openui-redesign-2026-10-12.md)と[登録・保存先](../../settings-openui-definition-storage-2026-10-12.md)を正本にする。例示値は利用者の保存設定ではない。

## 取り下げたもの

予約画面は今回の案から除外。「作業するプロジェクト」と「委任した作業」は後日検討する。external-work-v3.png、schedule-v3.png、delegated-tasks-v2.pngをPageの見本から取り下げた。dictionary-v2.pngは却下済み。settings-hub-v2.pngは予約と委任作業を含むため旧版とする。これらを再生成・実装の入力に使わない。ファイルは経緯の記録として残す。

外部作業の接続、実行前確認、担当定義には全体設計の記述があるが、プロジェクト画像をその代表として流用しない。画面見本はまだ確定していない。

## 生成と保存の記録

最初にLARMのSAAA-w-Image / qwen-image-2.1-turboで生成した。元のgeneration-manifest.jsonとprompt.txtはこの試行の記録である。フォームと一覧が意図せず増える出力を採用せず、修正版は組込みimage_genで作成した。LARMで予約見本の取消後に結果不明になった試用は自動再送していない。

selected-manifest.jsonには現在選んだ画像、組込み生成元、残っている生成指示、取り下げた画像、Pageの永続参照を記録する。screens.jsonは現在の生成対象だけを含む。画像の文字はAPI契約ではない。

今回確認したのは現行UIの読取、画像の見た目、アップロード先アクセス、Page本文への挿入と読戻しである。製品の移行動作、実サービス、実機器の受入は別途必要。
