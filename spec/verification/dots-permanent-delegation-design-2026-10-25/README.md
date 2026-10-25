# dots常用委任：画面案と実装の検証

> 後続の利用者指示で追加サーバー前提を撤回した。この文書・画像は以前の状態の記録。現行は[削除後の設計](../../dots-no-relay-cleanup-2026-10-25.md)を参照。


[設計と実装計画](../../dots-permanent-delegation-design-and-plan-2026-10-25.md) §11のレビュー用画像。製品画面の実装・操作試験・実仕事の結果ではない。仕事名・本文・日時・件数・接続状態は架空の表示例。

## 採用する画面構成

- [仕事と結果](workspace-panel-concept.png): Eumenesの既存アーティファクト領域。「仕事一覧」の一覧アイコン付きボタンから、見出し・閉じるボタン・状態付きの行を持つ浮動一覧を開く。Selectではない。行を選ぶと一覧を閉じ、同じ領域の詳細を切り替える。画像は一覧を開いた状態を示す。
- [設定](settings-panel-concept.png): 同じアーティファクト領域で、接続・作業先・担当と手順・受取と同期を縦に配置。保存・破棄は領域内の下書きバーを使う。設定フィールドの候補選択と、仕事一覧を開くボタンは別の操作。
- [利用者が示した既存の「資料一覧」](list-menu-reference.png): 仕事一覧の操作形式の参照。削除機能は今回の仕事一覧へ転用しない。

## 生成方法とプロンプト

保存済みLARM catalogから画像生成サービスを発見し、認証済みbackend経由で試したが、準備段階で `provider_failed` となり画像は得られなかった。その後、利用者が今回の2画面についてCodex標準の画像生成を明示的に選択したため、組込み画像生成を使用した。以降の修正は利用者の画面指摘を反映したもの。

最終プロンプト:

- 仕事画面: [workspace-menu-prompt.txt](workspace-menu-prompt.txt)。編集対象は [Selectを配置した中間案](workspace-select-draft.png)、操作の参照は利用者の資料一覧画像。
- 設定画面: [settings-panel-prompt.txt](settings-panel-prompt.txt)。編集対象は [設定初稿](settings-draft.png)。

生成経路・結果・初稿の扱いは [image-generation-record.json](image-generation-record.json) に記録する。生成画像内の文字や寸法は実装仕様の正本にせず、計画書と登録schemaに従って実装する。

## 不採用の初稿・中間案

- [workspace-concept.png](workspace-concept.png)、[settings-draft.png](settings-draft.png): 独立したアプリのように見え、既存アーティファクト領域を前提にしていなかったため不採用。
- [workspace-select-draft.png](workspace-select-draft.png): 領域内に修正したが、仕事の切替がSelectになっていたため不採用。利用者の「アイコンボタンで一覧を開く」という指示を最終案へ反映した。
- [workspace-prompt.txt](workspace-prompt.txt)、[settings-prompt.txt](settings-prompt.txt)、[workspace-panel-prompt.txt](workspace-panel-prompt.txt) は初稿・中間案の記録。

## D0〜D2実装後の確認

上の生成画像は設計レビュー用の記録で、以下は実装したEumenesを隔離したfixtureで動かした画面。本文・Session・結果は模擬データで、実dotsやクラウドの受入ではない。

- [仕事と結果の実画面](workspace-browser.png)
- [約320pxの領域内で開いた仕事一覧](workspace-narrow-browser.png)
- [設定保存後の実画面](settings-browser.png)
- [設定の下書きと保存操作](settings-before-save.png)

実装内容、検証コマンド、全体検査の未解決事項とD3以降は[実装・検証記録](implementation-d0-d2.md)に記録する。生成画像そのものを実装済みの証拠として使わない。
