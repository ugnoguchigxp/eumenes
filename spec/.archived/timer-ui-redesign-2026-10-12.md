# タイマー画面の再設計

目的: 時間設定と計測表示を統一した時計アプリに整える。前版の汎用フォームを置き換え、時間の直接入力、プリセット、円形ダイヤル、大きな開始操作を備える。

再利用: timer APIとreceipt、server clock補正、expiry確認、取消・通知、共通OpenUI Rendererと操作ロックを保持する。会話の指示・利用可能ツールは既存timers.manageを参照済みで、今回変更しない。

範囲と依存: props/eventsだけを扱うDesignSystemのTimerWorkspace → OpenUI view/schema/source登録 → setupと計測ホスト → ブラウザで視覚確認。既存の汎用formは時間入力と時計表示を統合できないため、時計の表示と設定を担う部品を登録する。業務API、DB、LLMの意味判断、通知音は変更しない。

画像: 時計の目盛りと進捗は解像度に依存せず状態に追従するSVG/CSSで作る。画面の読みやすさに直接必要な表示を優先する。

完了条件: 部品とAPI接続の試験、OpenUIで他の登録viewと合成できること、開始・取消・プリセット・キーボード操作・24時間境界、明暗テーマと狭幅の画面画像点検、domainと全体gate、差分点検。

ベースライン: 前ターンの全体gate成功、timer browser8件成功。既存未コミット差分は保持。

実装済み: DesignSystem TimerWorkspaceをOpenUI `timer-workspace` viewとして登録。設定時は時間・分・秒の直接入力、1/3/5/10/25分プリセット、名前、大きな開始操作を表示。計測中は保存済み状態から円形の進捗リング、残り時間、終了予定、取消、新規設定を表示する。通常の数字は大きく、1時間以上の8桁表示は収まるサイズにした。

表示定義: 設定は `timer-setup`、計測は `timer-保存ID` の認証済みsourceを参照するOpenUI JSON。同じtimerタブへ切り替える。以前のtimer種別は互換表示だけ残す。共有Renderer、入力/操作ロック、client APIを再利用する。

検証済み:

- DesignSystem部品3件成功（プリセットと名前保持、送信中の再操作防止、host時刻と取消イベント）。Storyを設定・計測・終了・取消・エラー・狭幅で用意。
- 関連Web85件成功。タイマーと質問の組合せを実際のOpenUI Rendererで描画し、誤ったsource種類と不在sourceを拒否。
- timers gate成功（backend14件、Web33件）。全体型検査とWeb build成功。担当ファイルのformat/lintと差分の空白検査成功。
- 明暗・375px幅の設定画面、計測画面の画像を点検。数字と円形ダイヤル、入力欄とプリセット、操作の間隔を調整。横方向のあふれなし。
- 写真記録を伴うブラウザ結合で、プリセット → 90秒開始 → 時計 → 閉じる → 再オープン → 取消保存確認 → 新規設定への戻りが成功。
- 最終タイマーブラウザ試験8件すべて成功（2.4分）。24時間、明暗・狭幅、終了通知、タブを閉じた後の音、再開時の音声有効化も含む。

検証中の修正: プリセットの読み上げ名を明示し、処理中も開始/取消の操作名を維持。撮影中のbuild更新でViteが画面を再読み込みし要素が外れたため、buildを完了してからブラウザを起動する順へ修正。撮影時だけCSSアニメーションを止めた。OpenUI部品数の固定値を、登録済みview名とCompositionの集合に厳密一致する検査へ変更し、追加された時計を許可された部品として確認する。

担当外による未完了gate:

- artifact gateは設定画面の並行変更3ファイルのformatで停止（`settings-components.tsx`、`settings-contracts.ts`、`ArtifactShowcase.tsx`）。その箇所は編集しない。関連Web85件を別途実行して成功。
- verify:allは `api/domains/agent-runtime/service/step-actions.ts#createStepActions` が306行で300行制限を超えるためsize-budgetで停止。担当外なので修正しない。全体型/buildは別途実行して成功したが、全体gate成功とは記録しない。

証拠: [検証ログ](../verification/timer-ui-redesign-2026-10-12)、[設定・計測の画面画像](../verification/timer-ui-redesign)。live LLM・実スピーカー/マイク受入は変更していないため未実施。fixtureの音声試験を実機器受入とは扱わない。

差分点検: 発話・場面を識別する分岐、LLMの意味判断の代替、API/DB/通知音の変更を追加していない。プリセットは明示的な利用者操作であり自動の用途判断に使わない。表示部品にAPI・interval・業務状態の正本を持たせず、hostが既存保存状態と時計補正からpropsを供給する。並行の設定画面等の変更を保持し、担当外を上書きしていない。

Context Still: 今回context_compile 1回、compile_eval 1回。会話累計各2回。今回runId `00000000-0000-0000-18dd-cc8958ae2a24`。

残作業: タイマー画面の実装・個別検証は完了。全体gateは上記担当外の変更を修正した後に再実行する必要がある。
