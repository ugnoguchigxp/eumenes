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

2026-10-13追記：ユーザー指定により次の単位として[音声と入力](../settings-voice-input-2026-10-13/README.md)を移行・確認済み。上の次作業候補よりユーザー指定を優先した。旧画面削除は引き続き最後。

## 2026-10-13 会話画面の保存操作の修正

会話フォームには変更一覧へ移動するボタンだけがあり、画面内から保存できなかった。既存のSettingsDraftHost.applyと公開settings apply APIを再利用し、SettingsSection共通部品に「設定の変更をすべて保存」を追加した。OpenUI sourceへbusy・blocked・messageを渡し、会話・音声と入力・変更一覧の登録済みsourceから同じsettings-applyを受付する。未変更・保存中・未確定の接続登録があるときは保存不可。変更一覧・共通下書き・revision／receipt・保存中の追加編集・認証・競合検査は維持する。

最初に回帰試験で保存ボタン不在を再現し、修正後の結合試験で同じ画面での保存、失敗後の入力保持と同じrequestIdによる再試行、保存中の無効化、API読取を確認した。保存は全設定の共通下書きが対象で、ラベルも「すべて保存」としている。語句による意味判断、SQL・別writer・DB migrationは追加していない。

部分・結合：settings backend23件／Web48件、artifact49件、TypeScript、lint、DesignSystem build、Web buildが成功。全体gateは担当外の既存agent-runtime関数306行のsize-budgetで停止した。今回の変更は制限内で、基準・担当外実装は変更していない。

通し：隔離DB・通常API・Chromiumで会話画面から保存し、API読取・画面再読込後の名前2件と口調を確認した。390px表示でもスクロールして保存ボタンが画面内へ収まることを確認し、conversation-direct-save.png／conversation-direct-save-narrow.pngを目視確認した。最初のブラウザ一括実行は既存3件成功、新規1件は保存とAPI読取まで成功したが、再読込後の会話ボタンが操作中にDOMから外れtimeoutになった。同時にDesignSystem再ビルドを行っていたため、ビルド完了後、製品コード・試験期待値を変えず新規試験のみ再実行して1件成功した。その後、狭い画面のviewport検査とスクロール後の証跡を追加し、同じ試験が成功した。今回の追加した保存・再読込確認はfixture API環境であり、利用者の通常設定を試験用の名前へ変更していない。

## 2026-10-13 表示のOpenUI移行

目的・範囲：既存5項目と字幕見本を移し、画面内の保存まで接続する。完了条件は全選択肢、保存・破棄・閉じて再開・再読込、会話への反映、共通部品への影響を確認すること。LLM・Provider・DB schema・既存設定画面の削除は対象外。既存のSettingsSection、共同下書き、許可source/action、settings apply APIと単一writerを再利用した。

登録：`settings-display`の編集viewと、読み取り専用の`settings-display-preview`をOpenUIのlayoutで構成する。後者のviewは`subtitle-preview`。新しいArtifact種別・専用React画面は作らない。既存の字幕見本にはDesignSystem部品がなかったため、SubtitleとSubtitlePreviewを同層に追加し、既存字幕の描画・CSSを移した。見本と読み上げ中の字幕が同じ部品を使う。再利用可能なprops/eventsの範囲に閉じ、API・認証を持たせない。

| 表示項目 | settings_document(id=1).document の保存先 | 候補 |
| --- | --- | --- |
| 会話の背景 | $.general.background | light-fairy / spatial（未設定時は光の妖精） |
| テーマ | $.general.theme | system / light / dark |
| 読み上げ字幕を表示する | $.general.subtitles.enabled | boolean |
| 字幕のデザイン | $.general.subtitles.style | netflix / prime / classic / glass |
| 字幕の大きさ | $.general.subtitles.size | medium / large / xlarge |

Bindingは所有schemaで値を検査する。保存先の文字列は監査用で、実行するJSONには渡さない。背景の未設定状態を復元し、変更一覧へ誤った旧画面の変更行が出ないことも確認。表示の5項目だけをこのsourceから編集でき、未知の候補・他フォームの項目・previewからの変更・古いrevision・重複操作を拒否する。共同下書きの他画面の変更も同じ保存に含む。見本だけは編集中の値を反映し、会話の背景・テーマ・読み上げ中の字幕は保存値を使う。

部分・結合：DesignSystem単体2件、Storybook（Chromium）7状態成功。表示の新規結合2件と既存フォーム・字幕・ワークスペースを含む13件成功。settings backend23件／Web51件、artifact49件、background9件、voice-dialogue backend65件／Web42件、Web全体366件成功。TypeScript、DesignSystemの型、lint、DesignSystemとWebのbuild、担当差分の空白検査が成功。

通し：`tests/browser/settings-display.spec.ts`の2件が成功。隔離DB・通常API・LARM fixture・Chromiumを使用し、背景2種のWebGL描画と旧canvasの解放、テーマ3種と端末明暗への追従、字幕4デザイン×3サイズの実CSS、全5項目の保存とAPI読取、再読込、閉じた下書きの保持、変更一覧と破棄、390pxのスクロールと保存ボタンを確認した。fixture音声をブラウザで再生し、保存した字幕デザイン・サイズと表示／非表示が実際の読み上げ字幕へ反映することも確認。画像は`../settings-display-2026-10-13/display-saved.png`と`display-narrow.png`。起動中の通常画面でも表示メニュー、全5項目、保存ボタン、見本を確認し、`display-live.jpg`に記録。普段の設定は変更せず、実TTS生成・マイク許可・実機器の受入は行っていない。

確認中の失敗：撮影用にCardTitleをheadingとして探す試験を追加したが、既存CardTitleはdivのため待機になった。試験を中断し、実際の設定パネルを撮影対象にして2件とも再確認した。製品側の機能・試験期待値を弱めていない。並行するタイマー作業のonPause追加と生成済み型の更新の間に型検査が1回停止したが、両方に同じpropsがあることを調査し、担当外ソースを修正せず再検証で成功した。

全体gate：verify:allは既存のagent-runtime/service/step-actions.ts#createStepActions 306行のsize-budgetで停止。全体成功とは扱わない。時計・対話・Web調査等の並行変更は保持し、今回の成果には含めない。差分点検で言葉・場面ごとの意味判断の分岐、任意SQL、別writer、権限緩和を追加していないことを確認した。表示の移行と上記確認は完了。Spatialの実機器計測は既存どおり未実装であり、表示画面からもその制約を説明する。旧設定画面は全移行の最後まで残す。
