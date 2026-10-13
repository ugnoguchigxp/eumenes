# 画像生成

会話で画像を依頼するか、右上の「アーティファクトを開く」から「画像生成」を選びます。画像スタジオは通常のアーティファクト枠内に開き、会話画面と並べて使えます。枠のサイズを調整でき、制作フォームは枠内でスクロールします。上部右側の「画像一覧」と「画像生成」で、制作画面と一覧画面を相互に切り替えます。画面内の履歴タブはありません。

制作画面は上に小さなプレビュー、下にフォームを配置します。表示だけを縮小し、生成・ダウンロードする画像の実寸は設定どおりです。テーマ・画風・雰囲気・構図・光を選ぶと「画像作成プロンプト」を組み立て、その文章を自由に編集できます。音楽生成と同様、手編集後の選択変更では文章を保護し、「選択内容を反映」か「編集内容を使う」で決めます。置き換えやリセットした文章は「編集内容に戻す」で復元できます。幅、高さ、保存形式、シードは個別に指定します。縦横はそれぞれ100〜1280pxの整数で、32の倍数に丸めません。初期値は512×512、WebP、シード0です。品質や画風はプロンプトに書きます。参照画像を使う編集は現行LARM APIでは未対応です。

過去の画像にはLARMに保存された画像を表示します。画像を選んで拡大・ダウンロードでき、作成日と寸法を表示します。新しい順・古い順で並び替え、一覧を更新できます。各画像の削除ボタンで対象を確認して「削除する」を押すと、LARMの保存画像を物理削除します。復元はできません。成功後は一覧と選択プレビューから外し、失敗・通信切断では削除済みと表示せず一覧を更新して確認します。生成履歴と文章はEumenesに残ります。画面を閉じても保存画像は残ります。画像の正本と容量管理はLARMが担当し、Eumenesは生成状態、依頼、計画、成果物の参照を保存します。LARMで削除された画像の実体は取得できません。

## 接続

`toolchain:image.create@1`（会話関数`image`、引数は共通の`request`）から`package:image.create@1`を起動します。`profile:image.create@1`、`skill:image.create@1`、`tool:image.generate@1`を登録し、画像domainの計画担当が生成・編集画面・履歴の意図を解釈します。画面表示だけでは生成APIを呼びません。

LARMの保存済み接続先とbackend内のControl認証を使い、`SAAA-w-Image`から`qwen-image-2.1-turbo`のサービスを発見します。`services[].url`を優先し、現行の`endpoint`にも対応します。`description`を確認し、生成POSTは一度だけ送ります。同期APIのため取消時にはローカル受付を取り消し、遅い生成結果を採用しません。外部で処理済みの画像がLARMの履歴に残る場合はあります。結果が不明でも生成POSTを自動再送せず、一覧を更新して確認します。

| API | 用途 |
| --- | --- |
| `GET /api/images/generations?conversationId=main` | Eumenesの生成・表示操作の状態 |
| `GET /api/images/library` | LARMの保存画像一覧 |
| `GET /api/images/:id/content` | 認証済み画像取得・ダウンロード |
| `DELETE /api/images/:id` | LARM保存画像の物理削除。HTTP200、`{id,deleted:true}`。不存在404、結果未確認502。自動再送しない。 |

WebとclientはAPIを使い、画像URLは同一originの認証proxyを通ります。表示JSONは`{"view":"image-workspace","source":"image-studio","title":"画像生成","presentation":"embedded"}`を保持し、状態・画像一覧・実行時URLはホストが解決します。DesignSystemの`ImageWorkspace`・`ImageCreationForm`・`ImagePreview`・`ImageGallery`をOpenUIの登録部品として呼び出します。各部品は同じsourceを使ってJSONで合成できます。通常は共通のArtifactPanelが表示枠・リサイズ・タブの閉じる操作を扱います。部品の任意の全画面表示には`FullscreenDialog`も利用できます。アプリの暗色・明色テーマを継承します。

## 検証

固定試験: `bun test api/domains/image/test api/domains/larm/test/image-library.test.ts api/domains/capabilities/test/image.test.ts api/application/image-e2e.test.ts`。JSON合成・ホスト操作は`web/src/domains/image/`、部品はDesignSystemのImageWorkspace、画面操作は`tests/browser/image.spec.ts`で確認します。所有domainと利用側domainのverify後、横断変更はverify:allを実行します。

実接続: `bun scripts/image-live.ts --run`は隔離backendの設定APIに接続先を保存し、実モデルの担当選択から画像生成までを一度だけ行います。`--library-only`では新しい画像を生成せず、実モデルの一覧表示計画とLARM一覧取得を確認します。生成した確認画像はLARMに残します。結果は`verification-reports/image-toolchain/`に保存し、通常ログには本文や秘密を入れません。

2026-10-13の実生成では512×384 PNGを取得・表示し、約14秒、258,329 bytes、指定どおりの寸法を確認しました。実モデルの一覧表示も新規生成0回で確認しました。経路ごとの確認結果は[作業記録](../spec/image-toolchain-work-record-2026-10-13.md)を参照してください。


2026-10-13の承認デザインに合わせた画面は[実装記録](../spec/image-ui-design-implementation-2026-10-13.md)を参照してください。`bun scripts/image-ui-check.ts --run` は隔離backendのUIからLARM保存画像の先頭12枚を読み取り、制作・一覧・取得・狭幅・閉じるを確認します。計画モデルはfixtureで、画像生成POSTは拒否します。既存画像を使うUI確認を実モデルの新規生成成功と混同しません。
