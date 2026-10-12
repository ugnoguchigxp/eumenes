# 設定アーティファクトへの段階的移行

目的は既存設定画面を残したまま、アーティファクト入口へ設定を追加し、フォームを一つずつOpenUIへ移すこと。既存設定画面の削除は全対象フォームの移行と受入の最後に行う。

今回の単位は設定入口、会話フォーム（名前2件と口調）、変更一覧、既存settings.applyへの接続。新旧表示が共通下書き、秘密入力、冪等性、版競合、保存中の追加入力を共有する。予約・Project・委任作業画面は今回の登録対象にしない。DB・認証・LLMの指示と会話のツールを変更しない。通常の手動設定操作なのでLLM推論は不要で、表示は登録JSONと許可sourceを通す。

作業順は既存保存処理のホスト抽出、DesignSystem部品とOpenUI登録、設定定義とsource・操作、ワークスペース入口、新旧共同下書きの結合、画面確認。完了条件は設定を開く、会話を編集、閉じて復元、変更一覧から適用、旧画面にも反映すること。未知項目・不正値・古いイベントの拒否、版競合、再送、保存中の追加編集をfixtureで確認する。

検証は部分→結合→通し。settingsとartifactのdomain検証、利用側のワークスペース結合、verify:allを実行する。既存検証ロック・他作業による入力変更・担当外失敗は分けて記録し、ロック削除や期待値緩和で通さない。UIのためのLLM生成、TTS、マイクの受入は今回の変更対象ではないため実行しない。

着手時：下書きはSettingsPageのローカルstate。ArtifactLauncherに設定はなく、OpenUIのsettings viewは試用専用。本番設定へ接続しない。

今回の実装済み範囲：共有ホスト抽出、settings-navigation / settings-section / settings-changes登録、3会話項目の型付きbinding、ArtifactLauncherの設定入口、既存設定画面との共同下書き。

保存先は既存settings_document(id=1).documentの$.general.agentName / $.general.userName / $.general.persona。既存POST /api/settings/applyのstrict schema、expectedRevision、requestIdとwriterを使用し、DB migrationはない。物理保存先・接続情報・秘密はOpenUI snapshotへ渡さない。表示JSONはsource名と登録viewだけ。

変更一覧の3会話項目以外の旧画面での変更は「既存の設定画面の変更」と要約する。完全な項目別変更表示は以降のフォーム移行時に拡張する。新たなクラウドAPI対応、全フォームの移行、8タブ押出しの専用受入は今回未実施。タブ閉鎖の保持と再表示は受入済み。

検証：変更前の既存3ファイル13試験成功。settings domain（backend23、Web37）成功。artifact domain49試験成功。ワークスペースを含む追加結合6試験成功。隔離DB・通常API・Vite・Chromiumで設定入口、編集、タブ閉鎖と再表示、新旧共同編集、適用、API読取、リロード後の値を確認し1通し試験成功。LARM未構成の警告はfixtureの想定状態で、生成は実行しない。

修正した途中失敗：ホスト抽出後の関数行数上限はfooter分離、refsのrender内操作はeffectへ移行、冗長ARIA roleを削除。追加登録で既存の固定コンポーネント数試験が失敗したが、別作業による登録一覧との一致検査への更新後にartifact検証成功。テストの名前指定とfixtureのschema importを修正し、保存と入力保持の要件は維持した。

起動中の実画面では設定入口の登録を確認した。別作業のHMR更新で表示が繰り返し初期化されたため、保存の通し確認は隔離fixtureで実施し、通常DBの設定は試験のために書き換えていない。

横断gate：bun run verify:allはapi/domains/agent-runtime/service/step-actions.ts#createStepActionsの306行によるsize-budgetで停止。担当外のため修正しない。全体成功とは扱わない。ブラウザ証拠画像が並行作業のtest-results初期化で消えたため、証拠の保存先を本ディレクトリへ変更し、狭い画面のキーボード確認を加えて通しを再確認する。

最終確認：Web全体68ファイル340試験成功。DesignSystem型確認とWeb build成功。証拠保存先変更後のブラウザ再確認で、冷たいViteと全操作の30秒枠を超えたため60秒へ変更。各操作の期待値と20秒のexpect上限は変更していない。ほかの重い検証と同時に実行せず再確認し、21.9秒で1試験成功。狭い画面のTab順（あなたの名前→口調→変更一覧）も成功した。

起動中の実画面はDOMによる操作へ切り替え、設定入口と会話フォームの表示を確認できた。通常DBの書込みは行っていない。Pageへ最初の移行状況と、旧設定画面を最後に削除する方針を反映。

差分点検：追加の分岐は登録view/source/action/fieldと既存公開操作の接続のみ。発話の意味を語句条件で代替する処理、任意SQL・JSON pathの実行、専用Artifact種別、新しい保存writer、DB migrationを追加していない。タイマー・実行担当等の並行作業の変更を維持し、この作業の成果に含めない。

今回の単位は完了。全対象フォームの移行と全体gateの成功は未完了。次の作業単位は表示フォームを同じ登録・共有下書き・OpenUIで移す。既存設定画面の削除は最後。
