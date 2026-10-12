# 背景切替とThree.js描画基盤の検証

2026年10月12日のfixture検証。実装の対象は背景選択と保存、Spatialの単一Canvas、モデル登録と更新、resize、停止と資源解放、HTML一覧、描画失敗時の再表示である。

## 対象の結果

- 変更前: avatar 6試験、settings backend 22試験、既存アバターと表示設定 7試験が成功。
- 部分と結合: 背景・モデルscene・背景切替・既存アバター・表示設定のWeb試験18件、settings backend 23件が成功。
- `bun run verify -- --domain background`、settings、conversationを実施。背景domainの9試験と利用側の検査が成功。
- WebGLを実際に使うブラウザ試験: 光の妖精からSpatial、保存、再読込み、Spatialから光の妖精、旧Canvasの解放、HTML選択を確認。単独実行と全体実行の両方で成功。
- 最後の変更後に全体TypeScript検査と背景切替の結合試験を再実行し成功。
- スクリーンショットを目視確認。仮モデルは4対象、すべて未確認。背景の操作部と会話入力を確認。
- 差分点検: 発話やサービス名の意味判断を専用分岐で置き換える処理は追加していない。モデルは明示された登録キー・状態だけを使う。

## 全体検証の結果

`bun run verify:all` は失敗。サイズ、domain境界、SQL境界、文書、format、lint、型検査、backend 1633件、Web 319件、client 317件、DesignSystem 1109件、Web buildは成功。ブラウザは26件成功、5件失敗、15件skip、flaky 0件。全体の検証済み宣言は行わない。

失敗は今回の背景基盤の担当外であり、実装や期待値を変更していない。

| 試験 | 確認できた失敗 |
| --- | --- |
| artifact-showcase サイズ変更 | 最後のArtifactを閉じた後もseparatorが1件残る |
| artifact-showcase タブと余白 | header paddingが期待0pxに対し0px 148px 0px 0px |
| dots | startVoiceStackの準備がlarm_not_readyで失敗 |
| voice-input | 同じstartVoiceStackの準備がlarm_not_readyで失敗 |
| voice | 同じstartVoiceStackの準備がlarm_not_readyで失敗。後続試験がskip |

startVoiceStackは保存設定のURLだけをfixtureへ変更しており、現在の既定Profileはornith1.5Strix。一方、larm-fixture-serverはSAAA-gemma4-26bを広告している。Profileの不一致が準備失敗の原因候補となる。修正にはfixtureの所有範囲で対応・検証が必要。

## 作業ツリーと範囲

着手時から多数の未コミット変更があり、作業中に会話画面がApp.tsxからworkspace配下へ分割された。分割を維持し、ConversationPanelの背景入口だけを接続した。背景以外のArtifact・Provider接続・ツールチェーンの変更は元の作業のまま残している。

Three.jsの型定義を追加したため、既存の光の妖精には固定長配列・uniformsの型情報とshader hookの引数転送を整備した。形状やモーションの変更はしていない。

このMacの実測、Provider health、実マイクとスピーカーの受入、性能比較はこのfixture検証に含めない。Dotsが作成する最終モデルも未接続である。

- [画面確認](spatial-background.png)
- [全体verifyの結果](verify-all.json)
- [ブラウザの結果](browser-results.json)
- [モデル組込み手順](../../../docs/backgrounds.md)
