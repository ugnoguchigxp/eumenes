# GPT-Live音声会話の実装・検証記録

2026-10-31、Asia/Tokyo。製品実装・固定試験・設定画面の反映まで確認した。実APIでの音声応答、日本語品質・遅延の測定、本人のマイクとスピーカーでの3往復受入は未実施で、音声MVPの受入完了とはしない。

## 実装と接続

- `live-voice` domain: backend主WebSocket、連続PCM、認証付きHTTP/SSE、原文字幕台帳、入力版とepoch、委任の重複防止、終了・切断・保存不能時の停止。
- Settings: `settings.live@2`、`settings.hub@9`。既存の共通下書き、AES-256-GCMの資格情報、設定adapter、登録bundleを再利用。モデルはAPIで取得した候補、声は公式Live契約の列挙候補とAPI既定のSelectBox。話し方の補足は固定候補のない自由記述。
- Web: 入力欄近くの開始・終了・マイク休止・設定アイコン。利用者とAIの字幕原文を表示し、閉じた受信範囲を通常履歴へ一度だけ公開する。音声ファイルは保存しない。試用字幕は終了・復旧で削除する。
- Dialogue: 保存済み利用者メッセージを既存の受付へ渡し、担当選択・引数・実行・承認・非同期仕事を再利用する。文字補足はLiveへ伝え、同じ入力版の委任を再利用する。外部実行直前と結果採用で古い版を拒否する。引渡し済みの仕事は音声の割込みだけで取消さない。
- 配信: 案内は画面の描画、確認は内容を確認する明示操作を証拠とし、既存の承認条件へつなぐ。backendの案文・Liveの受付ACKを実際の発話や既聴として保存しない。主返答・専門担当・agencyの提案の出力先をLiveへ接続した。
- 排他: 通常ASR/TTSの受付、準備・試聴・自動読み上げ・replay、設定のASR/TTSサービス試用を停止・拒否し、吹き出しを両方OFFにする。他の種類のサービス試用や担当の仕事は停止しない。

専用実装は生PCMとLiveプロトコルの接続、容量・順序・失効の強制に限定した。利用者の特定の言葉、題材、モデル名を分類する製品分岐は追加していない。モデル名・profile名のコード既定値は追加していない。声の識別子は[公式主WebSocket仕様](https://developers.openai.com/api/reference/resources/live/primary-websocket)の列挙であり、モデル名やprofile名ではない。

## 固定検証

| 段階 | 対象 | 結果 |
| --- | --- | --- |
| 変更前 | settings credentials、conversation、routedの対象試験 | 41件成功 |
| 基礎実装の関連11領域 | settings / live-voice / conversation / dialogue / voice-dialogue / inference / continuity / delivery / capabilities / audio / service-tests のverify | Bun 1,297件、Web 223件成功。型・境界・SQL所有・サイズ・整形・lint・SystemContext・DesignSystemも成功 |
| 保存不能・設定試用の排他の追加後 | live-voice / service-tests のverify | Bun 40件、Web 2件成功 |
| 設定v2の登録・関連機能 | settings / live-voice / service-tests のverify | Bun 149件、Web 19件成功 |
| Selectと共通保存 | settings-dataの実artifactを描画し、APIで取得したモデル・登録された声を選び共通下書きで保存 | 新規試験成功。既存設定、Composer、Live管理を含む4ファイル15件成功 |
| 起動構成 | server import、副作用なしの別プロセスimport、サービス構築と正常終了 | 3件成功。実サーバーを起動する3件はこの固定試験では対象外 |
| ブラウザ | `tests/browser/live-voice.spec.ts`。900px / 390px × 明 / 暗、開始・終了、ASR/TTS OFF、原文字幕、確認操作、Select、保存バー、入力欄の幅と右端 | 4条件成功。サーバーを作らず、製品部品と登録bundleを描画 |
| ビルド | `bun run build:web`、最後のUI変更後に`bunx vite build` | 成功 |
| 最終静的検査 | 全2,719ファイルの型、lint、全体サイズ、整形、差分の空白 | 成功 |
| bundle | `bun run toolchain:bundle -- check api/domains/capabilities/bundles/settings.live.bundle.json` | issueなし。隔離DBでの検証で、製品DBへの登録とは区別 |
| 更新 | settings.live@1から@2のimport・再import、旧revisionの保存内容・digestの不変 | 成功。旧版fixtureはcommit `6ba1c43e` のbundleを保存 |

全体verifyの成功記録は `verification-reports/runs/2026-10-31T10-34-43-424Z-70dfa67f-39d6-4db2-b841-b8b5fcc4310a/report.json`。保存不能対応後は `2026-10-31T10-50-01-880Z-6be484c5-405c-4154-a0a7-c3d33ece0255`、設定v2は `2026-10-31T11-13-11-881Z-2e1e6496-0be8-478f-9d4c-a25dc81eaf78` の同じ場所に記録した。時刻を含むrun名はUTC。

固定試験では空白・反復、同時の字幕、委任が先に来る場合、文字補足の再委任、確認の配信、キー更新、訂正・削除、切断、無音送信、保存不能・古い実行の拒否・保存復旧を確認した。固定モデルは実際の意味判断・文字起こし品質の正しさを保証しない。

## 反映と保存設定の確認

利用者が「再起動してください」と明示した後、既存のdev管理プロセスを正常終了し、通常の `bun run dev` でAPI・画面サーバーを起動した。最初のバックグラウンド起動は常駐しなかったため、継続する実行セッションで起動した。20:19頃にAPIと画面の起動を確認した。

稼働中APIで `artifact:settings.live@2` の公開、保存済みの公式接続の資格情報が利用可能なことを確認した。キー本文は取得・表示していない。実際の `http://127.0.0.1:5173/` を別のブラウザで開き、モデル・声がSELECT、声の選択肢が32（API既定を含む）、保存バーが表示されることを確認した。会話の送信・音声の開始・設定値の変更はこの確認で行っていない。

[実画面](deployed-settings.png)、[保存状態の安全な要約](deployed-state.json)。画面の固定試験は[390px暗](ui-390-dark.png)、[390px明](ui-390-light.png)、[900px暗](ui-900-dark.png)、[900px明](ui-900-light.png)。

読取確認時点ではLiveの利用はON、クラウドへの送信許可はOFF、Live用の接続とモデルは未選択だった。利用者が「音声会話」タブで接続・モデルを選択し、送信を許可して保存してから音声テストへ進む。実機器で3往復の受入を通すまでは完成としない。

## 試行中に修正・切り分けた点

- bundleのID形式、重複する設定パス、navigation構成、改訂時の未定義属性を既存の登録契約に合わせた。検査の期待値を弱めず、公開revisionは更新版として登録した。
- 境界・サイズ・lint・型の指摘は、公開口・責務ごとの分割・型と依存指定の修正で解消した。既存の試験用サービスには新しい排他状態の公開口を明示した。
- 一度の全体verifyは、別領域のshell/browserソースが検証中に更新され無効になった。成功扱いせず、修正後の安定したソースで再実行した。
- 最初の画面幅検査は内部のクリップを拾えなかった。目視で判明した後、共通ホストで既存のcontainer queryを有効にし、tabsのgrid幅を制約した。入力欄と保存ボタンの実際の右端も検査し、4条件を再確認した。意図的なfooter背景の余白は入力欄のはみ出しと区別した。
- 起動時のJS容量検査は既存の上限超過が残る。上限値は変更していない。変更前の対象10ファイルだけを一時的なViteロードで比較したとき、他のworkspace変更を含む比較元ですでにentry gzip 178,818B / initial 325,675B、Live基礎実装後は183,223B / 330,080Bだった（差分4,405B、最後のSelect変更前）。記録された上限は112,035B / 259,653B。全体の超過解消は担当外へ及ぶため実施しておらず、ビルド成功と容量検査の未達を区別する。

## 作業境界と残件

mainで作業し、新しい作業ブランチは作成していない。別のCodexチャットへの送信はしていない。並行作業の差分を保持し、途中で別作業により作られたcommitを巻き戻していない。プロダクトDB・資格情報のコピー、APIキーの表示、LARMサーバーの操作はしていない。製品ログへ字幕・音声・キーを追加していない。

この実装作業の `context_compile` と `compile_eval` は各1回。初稿・レビューを含む会話累計は各3回。

残件は、利用者によるLiveの接続・モデル・送信許可の保存、実APIでの権限・音声・日本語・遅延の確認、本人の機器での3往復受入、既存JS容量上限超過の担当範囲を決めた改善。キーの再登録は不要。

## 画像案に基づく再設計と開始設定（20:38反映）

以降は上記v2時点の残件を更新する最新結果。利用者から画像生成後の作り直し、実画面への反映、適切な開始設定、元の送信ボタンと邪魔にならないLive配置を依頼された。

内蔵のimage_genで[画像案](settings-design-reference.png)を作成し、[最終プロンプト](settings-design-prompt.txt)を保存した。案を基準に、共通SettingsSectionの暗黙の2列を解消し、トグルの右寄せ、全文幅の説明、選択欄の整列、複数行の補足、上部の見出し・保存バーを実装した。公開済み@1/@2は保持してsettings.live@3へ改訂。移行試験で両方の保存済み定義が不変であることも確認した。

送信ボタンが押し出される原因だったLive操作の兄弟要素を補助操作内へ移し、元の添付・補助操作・右端の送信の3列へ戻した。Live・休止・設定は小さいアイコンでまとめた。開始・排他・保存・委任・許可条件は変更していない。製品コードへの固定モデル名や利用者の語句による意味判断の分岐は追加していない。担当外の監視・背景の差分は保持した。

利用者の開始設定の依頼により、設定APIから既存のOpenAI接続を選択し、Live・クラウド送信をON、実APIのモデル一覧に存在し公式資料でもLive対応を確認できたモデルを保存した。声の保存値とAPIキーは保持した。マイクを送らないtestセッションでconnecting→active、明示終了後にclosed・errorなしを確認した。これは実機器での会話・音声応答の受入ではない。公式の照合先は https://developers.openai.com/api/docs/models/gpt-live-1 。

先に得ていた明示的な再起動許可に沿ってdev管理プロセスをSIGTERMで終了し、両ポートの解放後にbun run devを起動した。20:38に稼働APIの公開先がartifact:settings.live@3であることを確認。実際のブラウザでモデル・声・TEXTAREA・Liveと送信の配置、送信許可とLive有効の保存値を確認した。[反映後の画面](deployed-settings-redesign.png)、[暗い表示](deployed-settings-redesign-dark.png)、[安全な確認結果](deployed-redesign-state.json)。サーバーは起動済みなので、別途bun run devを重ねて実行する必要はない。

検証結果:

- 部分試験: 設定・改訂の3件成功（24 assertions）。設定adapterとComposerの初期確認18件成功。
- settings/live-voiceのverify: 140 Bun + 19 Web成功。記録: `verification-reports/runs/2026-10-31T11-35-36-537Z-0deaa058-3e32-4f3c-b1f5-8fccda091301/report.json`。
- 共通描画の利用側: settings-data、Composer、artifact-uiの57件成功。
- ブラウザ: 390/900/1440px×明暗の6件成功。説明文が細い列に潰れない幅、スイッチの右端、選択欄、複数行欄、保存欄、送信の右端とLive補助配置を確認。新設の配置試験は初回、非表示の添付inputまで子要素として数えて失敗したため、表示される領域と実座標を検査する形へ訂正し再実行した。
- 最終静的確認: 型2724ファイル、lint、サイズ2033ファイル、format3742ファイル、git diff --check成功。
- 生成案・実ブラウザ・固定試験の画像を目視した。暗い[広い画面](settings-1440-dark.png)・[狭い画面](settings-390-dark.png)・[入力欄](composer-390-dark.png)。

この再設計は画面と開始設定の修正に閉じ、音声の品質や遅延について新しい成功の主張はしない。残件は本人のマイク・スピーカーでの3往復受入。前項の既存JS容量超過は今回変更せず、上限を弱めていない。
