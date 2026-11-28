# Worksの準備と使い方

WorksはmacOS版Google Chromeで開く、Eumenesのローカル試作環境です。作品ごとにGitリポジトリを持ち、共通の固定版に対して型検査とビルドを行います。作品の依存は共有側だけにインストールします。作品単体でも同じ依存を使います。

## 固定版の準備

CoreとEumenesのデータ領域の外に、共有環境のソースリポジトリとインストール先を用意します。最初の版を作るときはCoreから雛形を取り出し、利用者のGit設定でコミットします。

```sh
bun scripts/works-runtime.ts export /absolute/path/WorksRuntimeSource
git -C /absolute/path/WorksRuntimeSource init
git -C /absolute/path/WorksRuntimeSource add .
git -C /absolute/path/WorksRuntimeSource commit -m 'Initialize Works runtime'
git -C /absolute/path/WorksRuntimeSource tag works-v1.0
bun scripts/works-runtime.ts pin /absolute/path/WorksRuntimeSource 1.0
```

共有先や別機器では承認済みのコミットIDとSHA-256を入れ、取得したリポジトリから導入します。

```sh
bun --no-env-file /absolute/path/WorksRuntimeSource/prepare.ts install /absolute/path/WorksRuntime \
  /absolute/path/WorksRuntimeSource 1.0 COMMIT_ID SHA256
```

この準備は固定版ごとに行います。配布を受けた機器で使う `prepare.ts` は、信頼できる共有環境のリポジトリから取得します。導入と作品の実行にCoreのチェックアウトは不要です。各作品にパッケージをインストールする操作はありません。

## Eumenesから開く

EumenesバックエンドとWebの設定に `EUMENES_WORKS_DIR`（新規作品の保存先。既存ディレクトリの絶対パス）と `EUMENES_PROTOTYPE_HOME`（インストールした共有環境）を指定します。任意の `EUMENES_PROTOTYPE_PREVIEW_PORT` の既定値は `8794` です。同じ設定値をバックエンドとWebに渡してください。ポートを固定すると、同じ作品IDのブラウザー保存先が維持されます。

Eumenesのランチャーから **Works** を開きます。新規作成では雛形と最初のコミットを作成します。既存作品を登録する場合は `prototype.json` があるGitルートを指定します。登録解除は作品フォルダを削除しません。フォルダを移動した場合は「移設」で結び直します。

## 会話から編集する

Claude Codeで編集する作品には、登録済み検査を含む固定版 `2.0` を用意します。発行・導入は上の手順で版とタグを `2.0`、`works-v2.0` に読み替えます。新規作品の既定を切り替えるときは `EUMENES_PROTOTYPE_VERSION=2.0` を指定し、既存作品は利用者が `prototype.json` の `environment` を変更して、型検査とビルドを確認します。固定版 `1.x` の作品は引き続きプレビューと単体実行に使えます。

Claude Codeにログインした同じ機器のEumenesで、「WorksのAlphaで見出しを変更してください」のように作品名を指定します。結果の作品リンクを押すと、Chromeでプレビューが開きます。会話に戻り、「同じWorks作品の見出しをもう一度変更してください」と続けられます。

同名の候補が複数あると、会話にフォルダ名を添えた選択肢が出ます。表示された番号（例 `作品 2`）を返すと、その作品で作業が始まります。

変更は作品の作業ツリーに残ります。完了には、最終変更に対応する型検査とビルドの成功記録が必要です。コミットとpushは利用者の操作で行います。

依存を追加できるようにするには、固定版のタグを管理する独立したGitリポジトリの絶対パスを `EUMENES_PROTOTYPE_SOURCE` に指定します。現在の固定版のタグとインストール済みの記録が一致している必要があります。

検査が未登録の依存を報告すると、会話にパッケージ名・版・用途と承認コードが出ます。表示された `承認 <コード>` または `否認 <コード>` を同じ会話で送ります。承認後は共有側で公開から7日以上たった版を確認し、インストールスクリプトを実行せずに準備します。型検査とブラウザー向けビルドを通過した固定版をローカルで発行し、対象作品だけの `environment` を更新して同じ仕事を再開します。新しい版のタグは共有環境のGitに残ります。 [Bunの依存インストール](https://bun.com/docs/pm/cli/install) · [npmのレジストリメタデータ](https://github.com/npm/registry/blob/main/docs/responses/package-metadata.md)

停止を確認できるまで、同じ作品の新しい仕事は待機し、移設と登録解除も保留されます。別作品は独立して作業できます。停止と排他の解放後、待機中の試作用ランナーは60秒で終了します。

## 作品で画像を使う

画像用アダプターを含む固定版 `3.0` を用意し、`prototype.json` の `environment` を `3.0` にします。保存画像を使う場合は `features` に `library.image.read`、新しく生成する場合は `media.image.generate` を宣言します。

作品を開き、本体パネルで保存画像を選ぶか、画像生成を許可します。本体パネルで説明を入力して生成すると、受付・空き待ち・完了の状態を確認でき、生成中の操作は取消できます。作品コードは `adapter.images.assets()` と `read(id)`、生成済み画像には `generations()` と `content(operationId)` を使います。画像データは `Blob` として受け取ります。

作品コードは `adapter.features()` で許可済みの機能を取得できます。`adapter.suggestImage(prompt)` で画像案を表示すると、利用者が本体パネルで案を採用し、生成を確定できます。

単体実行では `adapter.mode` が `sample` になります。`include` に `samples` を含め、`adapter.images.sample("samples/example.png")` で同梱画像を受け取れます。

## 既存作品を試験導入する

Works画面の「既存作品を試験導入」から、既存リポジトリのGitルート、入口のTypeScriptファイル、共有環境の版、使用するソースと素材を指定します。既存の入口が `#root` などに描画する場合は、表示先の要素IDを入力してください。

棚卸しには共有環境に不足する依存、宣言と固定版の違い、従来の起動コマンド、既存のHTMLやサーバーなどが出ます。試験中の設定と出力はEumenes側に置きます。登録解除後は元のリポジトリで従来のコマンドを使えます。

## 作品だけで開く

Worksの共有環境を用意したmacOS機器で作品をcloneして、作品のディレクトリから実行します。

```sh
export EUMENES_PROTOTYPE_HOME=/absolute/path/WorksRuntime
export PATH="$EUMENES_PROTOTYPE_HOME/bin:$PATH"
eumenes-prototype typecheck
eumenes-prototype build
eumenes-prototype dev
```

`dev` が表示するローカルURLを開きます。終了は `Ctrl-C` です。`dev --port=8796` で単体用のポートを指定できます。`build` の出力はGit除外の `dist/` に置きます。既存用途の `dist/` があるときは保護のため停止します。共有環境の指定や固定版が不足している場合は、表示された名前と版を確認してください。

作品の `package.json` も同じコマンドを呼びます。初めて開く作品では、作品側のBun設定を読み込まずに起動する上記の共通CLIを直接使います。型情報は作品の `.eumenes/tsconfig.generated.json` を介してエディターから利用できます。`.env.example` は公開設定の見本です。
