# ornith1.5 チャット画像入力の実装と検証

目的: JPG／JPEG・PNG・BMPをチャット全体で受け取り、サムネイル、添付解除、本文と画像・画像だけ・複数画像の送信、保存、履歴、後続質問での再送を提供する。

LARM契約: ユーザー提示の配備revision `86e879abe56ee54802d345c8b38f26f72b5e3570`と[仕様](https://github.com/ugnoguchigxp/local-LLM-harness/blob/01820f0197292f3e005176575cefd86bf0593a3a/specs/ornith-image-input-implementation-2026-10-13.html)。画像parts、能力発見、正式計数、保持metadataをこの契約に合わせる。1M token・4 SessionをLARMが管理し、個別の上限はclaimを使う。

## 変更と再利用

会話保存、単一writer、認証・Origin検査、bounded read、共通client、queue、取消、SSE、DesignSystemのButton・Modalを再利用した。主会話への画像入力を拡張し、用途別の分類・辞書・固定回答や画像専用ツールチェーンは追加していない。

- チャット全体のpaste/dropと添付ボタン、草稿サムネイル・拡大・添付解除、混在文字貼り付け、送信snapshot、履歴の認証付き画像取得を追加。
- `conversation/0006-attachments`で原本・正規化画像・preview・digest・所有者・会話・発言との順序付き関連を保存。既存migrationと文字資料のrevisionは維持。
- JPEG回転、白背景合成、BMP正規化には`sharp`と`bmp-ts`を使用。既存依存には3形式の完全デコード・EXIF補正機構がなかったため、入出力の検証・変換に限定して追加。
- 既存run受付のtransactionとrequestId判定に添付を統合。queue拒否で発言と関連をrollback。後続質問は保存済みの画像を毎回解決する。
- LARMの能力とchatInputをdiscovery/claim/renewで確認。全入力の最終JSON容量と画像制限を検査し、正式計数の契約・digest・モデル・画像数・出力予約・入力予算を照合。同一bodyとclaimで推論する。
- 画像欠損、未対応能力、計数不能、予算超過は明示失敗。画像を黙って省略しない。通常の文字、assistant tool_calls、native tools、streamの既存経路を維持。
- 主会話と補助controlは同じ現行profileと独立identityで接続する。構造的な機能抽出で既存の関数サイズ上限を維持した。

## 検証結果

- 着手前: conversationのbackend22件・Web31件、LARM135件成功。
- 追加部分・API結合21件成功。3形式の完全デコード、EXIF、alpha、破損・偽MIME・容量、所有者・会話分離、再起動、撤回、冪等性、順序、過去画像再送、欠損、queue rollback、正式計数、fits=false、取消、renew、結果不明時の再送防止、assistant tool_calls互換を確認。
- ブラウザfixture2件成功。ビルド済みの画面を隔離コピーして、自動更新による試験途中の草稿消失を防ぐ。paste/drop/選択、混在文字、解除・拡大、画像だけの送信、3形式、再読み込み、後続再送、狭幅、失敗時の草稿保持、未対応形式・枚数拒否。page例外0。
- live4ケース成功。実LARMへのEumenes経由送信でJPEG赤・PNG青・BMP緑の判別、後続質問、画像だけ、2画像比較。各要求で事前計数fits=trueと生成HTTP200を確認。画像数は順に3・3・4・6。保存済み設定を読み、隔離DBを設定APIで構成。既存データや別consumerのConnectionを変更していない。
- conversation gate成功（backend25・Web31件）、dialogue gate成功（backend209・Web6件）、LARM gate成功（146件）、inference gate成功（66件）。Web/DesignSystem build成功、root型チェック成功。
- `verify:all`は既存`web/src/domains/settings/MemoryItemsPanel.test.tsx`のsettings→memory境界違反で開始時に停止。今回の変更対象外なので修正していない。全体gate成功とは扱わない。

実推論の検証資料だけに非機密の合成画像と回答を保存し、通常の運用ログへ本文・原本・Base64・秘密を渡していない。実画像経路とfixture結果を区別している。

## 反映と残作業

ローカル開発環境のUI `http://127.0.0.1:5173`、API `http://127.0.0.1:8787`へ反映する。保存済み接続設定を維持し、起動時に追加migrationを適用する。LARM側の配備・profile変更は行わない。

稼働UIでは添付・解除とLARM保持方針の表示を確認した。差分点検を完了し、今回の画像機能とその試験・文書だけをcommit対象にした。他の進行中の変更は含めていない。commitはこの文書のGit履歴で確認できる。残作業は担当外の全体境界違反解消後の全体gate再実行。

制約: 元画像と送信用画像は3 MiBまで。実要求は過去画像込み8枚・4 MiBという現行claimの上限を受ける。超過時は明示停止し、自動縮小や履歴削除はしない。画像の長期記憶・クラウド画像入力・カメラ・動画は今回の対象外。

証拠: [検証資料](verification/chat-image-attachments-2026-10-13/README.md)。
