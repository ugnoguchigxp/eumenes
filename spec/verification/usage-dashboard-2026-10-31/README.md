# 利用状況アーティファクトの実装・検証

2026-10-31、Asia/Tokyo。独立メニューのアーティファクト。全画面ルートやアプリ全体のナビゲーションは作っていない。

## 画像と実装

組込み画像生成ツールで、アーティファクト枠だけの[画像案](artifact-design.png)を生成。[最終プロンプト](image-prompt.txt)を保存。画像の数字は例示であり実課金データではない。

実装画面: [900px・暗](artifact-900-dark.png)、[390px・暗](artifact-390-dark.png)、[1440px・暗](artifact-1440-dark.png)、[900px・明](artifact-900-light.png)、[390px・明](artifact-390-light.png)、[1440px・明](artifact-1440-light.png)。画面試験は架空データを返すAPI fixtureと実際の共通ArtifactHost・登録Rendererを使う。

登録: artifact:usage.dashboard@1 → adapter:usage@1 → query:usage.dashboard@1 / usage.rate-save → usage domainの公開操作 → 所有domainの読み取りport。OpenUIのusage-dashboard viewは共通DesignSystem部品へprops/eventsで接続。音声設定の既存revisionを保持し、新revision settings.live@4から関連画面として開ける。会話で判断する作業ではないため、新しいLLM担当やツールチェーンの会話用bindingは不要。

## 検証

- 部分: Live累計12→15→15、逆行・不正値、終了18秒、切断15秒の保持、試用字幕削除。SDKの全上流呼出し累計、別thread/turnの拒否、失敗時の保存を確認。
- 集計: 100件超の全件対象、失敗・取消・試用・不採用の保持、モデル完全一致、キャッシュの二重加算防止、null保持、JSTの半開期間、期間外の接続中表示、単価の改訂・適用開始を確認。
- 結合: 認証された独立launcher/source/保存操作、未認証401、不正期間400、料金保存の冪等性、Live設定からの移動先を確認。
- 標準: `bun run verify -- --domain usage --domain live-voice --domain inference --domain capabilities --domain artifact --domain settings`。Bun 957件＋Web 94件＝1,051件成功。[標準検証結果](verification-report.json)はpassで整合性エラーなし。境界・SQL責務・型・lint・format・サイズ・SystemContext・DesignSystemビルドも成功。
- 画面: `bunx playwright test tests/browser/usage-dashboard.spec.ts`、6件成功。[ブラウザ結果](browser-report.json)。Select、現在のSDKモデル初期選択、モデル変更、ページ送り、確認前に保存しないこと、確認後の保存を検証。全HTTP要求をroute.fulfillで処理し、待受ポートを作らない。
- 本番Webビルド成功。既存の大きなchunkとbackgroundの静的/動的import重複についてViteの注意表示あり。今回の範囲を広げる変更は行わない。
- 共通Rendererで説明文と集計を同じlayoutに置けることを静的表示で確認。[合成確認](composition-check.json)。確認後に残った一時レンダリングプロセスは終了した。

標準検証はソースを隔離コピーし、専用のDesignSystem distを使った。検証中は入力を編集していない。共通部品の通常ビルドも反映。サーバー操作・実SDK/Liveへの課金接続・製品DB/秘密の読み取りやコピーは行っていない。他の未コミット変更は保持した。

## 実装上の区別

Liveは途中受信量と終了時の有効な最終量を区別する。モデル・接続名は開始時の値を保存。SDKは毎回新規ephemeral threadで1turnのためtotalを使い、lastを全量として使わない。モデル変更時の累計を元モデルだけへ帰属させない。料金はLiveのUSD/分を履歴として登録し、SDKはtokensを主表示する。契約残量・credit・未確認の実請求額は表示しない。

旧移行試験は特定時点のmigration prefixを固定してから最新版へ進める形に更新し、旧データ保持と既存SQLのhash検証を維持した。保存列追加と新しい設定画面revisionに合わせた期待値も更新した。意味理解や担当選択の専用分岐は増やしていない。

実APIの金額照合・実機器での音声受入は未実施。音声機能全体の完成を示す記録ではない。新メニューとDB移行は通常の次回起動時に適用される。
