# 通知音の選択と試聴

2026-10-31の利用者依頼に基づく追加。既存の通知条件、LLMの指示・判断、writer・設定API・共通下書き・音声出力を維持し、LARMで制作した10種類の短い通知音を同梱する。

> 現在の状態（2026-10-31更新）: 最初の不合格10音は原音・加工後を保管。試聴合格のSE10音と、日本語・英語の男性による完了音声2つを同梱したsettings.voice-input@12を実装・検証済み。通常SEの11選択肢に加え、完了時の音声を独立して選択・試聴・保存できる。稼働画面への反映はサーバー再起動の明示許可待ち。音質の合格は利用者の実聴確認に基づく。


## 範囲・接続

- 制作はbackend用の保存済みsettings読取りと既存LARM playgroundのcatalog・music生成（task=sound-effect）を再利用。サービスのdescriptionを確認し、モデル・profileを固定しない。各音につき生成POSTは1回、300秒。途中失敗時は成功済み音を保持し、自動再送しない。
- 音源はsettings domainの同梱WAV（24kHz/mono）へ音量調整・端の短いフェードを施して保存。起動時・通知時・試聴時には生成しない。
- 設定文書のvoice.notificationSoundに10音のIDまたは従来のbeepを任意保存。未設定は柔らかいチャイム。未知IDは契約で拒否。DBスキーマや認証は変更しない。
- settings.voice-inputは旧revisionを保持した新版artifactを登録。既存select・settings-action・共通下書きの適用/変更確認を使用。試聴は保存前の選択で既存音声出力を再利用し、選択変更・閉じる・停止で中止する。
- 設定側から共通useTimerToneの音源取得口へ接続して音源だけを差し替え、通知発生条件・既読・claim・重複防止・繰返し・読み上げを維持する。既存音量、出力先、マイク抑制、取消を維持。音源取得失敗を成功にしない。
- 新担当、LLMプロンプト、ツール、新ライブラリ、独自プレイヤー部品、サーバー操作、無関係の並行作業は対象外。

## 依存順・完了条件

1. 現状の部分試験を記録。10音をLARMで制作し、デコード・長さ・無音/クリップ・ブラウザ再生を確認。
2. 選択契約・同梱音の取得、共通出力、設定新版・試聴を接続。
3. 部分試験（保存互換/不正ID/音源失敗/取消）→設定UI結合（保存前試聴/停止/保存/再表示）→bundle checkと `bun run verify -- --domain settings --domain audio --domain timers --domain capabilities`。影響先の通知試験も確認。
4. 通し確認は既存サーバーが利用できなければサーバーを起動せずブラウザfixtureを使用。実スピーカーでの聴取は区別。担当外失敗は証拠を報告し、修正しない。
5. 差分に個別発話の意味判断の置換・無関係変更がないことを点検。生成実体10音、設定保存・試聴・通知出力の接続を完了条件とする。

残作業: 音源制作、実装、段階検証、差分確認。

## 実装・検証結果

実装済み・fixture検証済み・LARM実生成済み。稼働中サーバーへの反映と実スピーカーの聴取は未実施。サーバー操作の許可は受けておらず、停止・起動・再起動していない。

- 10音は各1.5秒、24kHz/mono/PCM16 WAV。LARM catalogが返したサービスdescriptionを確認し、既存gatewayへ各1 POSTで生成。取得後に音量と両端のフェードを調整。同梱合計720,780 bytes。10音すべて異なるファイルで、実ブラウザのAudioContextでデコード、audio要素でendedを確認。加工後のpeak 0.129〜0.491を確認した。当初「クリップなし」と記録したが、これは後処理前の原音の品質を検査したものではなく、LARM調査で原音5件のクリッピングが判明した。減音後のpeakを根拠に原音の歪みを否定できない。内容の実スピーカー聴取とは区別する。
- 未設定の既存文書はそのまま読める。通知時の未指定値は「やわらかなチャイム」。従来のbeepも選べる。音源取得失敗時はビープへ切り替えず、配信成功を報告しない。取消後の音源を再生しない。
- `artifact:settings.voice-input@9` → `adapter:settings@1` → `notification.sound` / `$.voice.notificationSound` → 既存文書適用API。試聴は既存 `settings-action` のlocal操作。settings domainが同梱音を取得し、workspace・設定adapterが音源取得関数をaudioの共通出力へ渡す。audio domainにsettingsへの依存は追加していない。
- 既存settings bundleは16 artifactの契約上限だったため、旧revisionを変更せず `settings.notification-sounds.bundle.json` に新版を分離した。`toolchain:bundle check`はissueなし。初回の登録先誤りと上限違反は検査で発見・修正。画面試験は実UIの「通知音」タブを開いて操作するよう修正した。
- 変更前: 既存音声出力と音声設定の20試験成功。
- 部分・結合: settingsの保存・11選択肢・不正ID拒否・再openの1試験/24assert成功。Webのaudio/settings/settings-data/通知画面で24ファイル153試験成功。追加した音源の終了待ち・取得失敗・取消と新設定画面・通知archiveの最終3ファイル15試験成功。試聴状態の同期方法を既存sampleと同じ選択単位のstateへ調整した後、settings-dataと通知archiveの11ファイル52試験成功。
- `bun run verify -- --domain settings --domain audio --domain capabilities`: 成功。backend154試験、Web80試験、境界・型・整形・lint・DesignSystem build成功。report: `verification-reports/runs/2026-10-30T15-11-20-369Z-f4e5e47d-6dc4-4b79-99ff-46963e3e1766/report.json`。追加のaudio回帰試験後にaudio verifyも成功（67試験）。
- timersを含むverifyは、既存 `NotificationCenter.tsx` の timers→resources/kind-icon 直接参照違反で停止。HEADにも同じ参照があることを確認し、対象外修正はしていない。通知画面の個別試験は成功。すべてのdomainの合格とは扱わない。
- 最終 `bun check --no-pretty`: 2,802ファイル成功。対象のlint・format・`git diff --check`成功。`bunx vite build`成功、10音のWAVが配布assetsに含まれることを確認。既存の大きいchunkとbackgroundの動的import警告は残る。
- ブラウザE2Eは専用サーバーを起動しないため未実施。画面は実登録JSON＋共通adapter＋下書き・保存・復元のfixture、音源はサーバーなしの実Chromium再生で検証した。
- 俯瞰評価: 初期登録検証の反復時に、既存契約の上限と画面のタブ構造という新しい根拠を得て、bundle分割と試験操作の修正へ方針を更新。以後は登録・UI結合・音源実再生・domain verifyの成功で残作業を減らした。検証中の編集やサーバーの再起動は行わなかった。
- 差分点検: 個別発話の分類、固定応答、LLMの意味判断・優先順位・フォールバック、モデル/profile固定は追加なし。着手前からのdialogue等の差分と並行作業の音楽プレイヤー等の差分を保持した。

残作業: 利用者が許可する場合のみサーバーを再起動して画面へ反映。実スピーカーでの聴取。
context_compile 1回、compile_eval 1回。runId `00000000-0000-0000-18e3-56e7655e97a6` の評価を保存済み。


## LARM調査受領後の対応（2026-10-31）

目的と完了条件を更新: 元10音を不合格として履歴・原音を保全し、生成済みの5秒候補2つをそのまま提示する。チャイムの音色・雑音・歪み・余韻を実聴で確認した音だけ、適切な区間を選んで編集・採用する。現在は候補の試聴待ちであり、制作完了ではない。

受領したLARM調査は `/srv/ai/apps/local-LLM-harness/specs/notification-sfx-investigation-2026-10-31.html`。同文書をread-onlyで取得し、ローカルの `verification-reports/notification-sounds/larm-investigation-2026-10-31.html` に保持した。SFXルート・設定・GGUF checksumが整合、原音5件に飽和、代表のCPU/HIP相関約0.96、1.5秒と5秒の挙動差を確認したとの報告。原因がモデル本来の挙動・変換/量子化・native実装のどれかは未確定。scheduler不具合の仮説は撤回され、highへの変更の有効性も確認されていない。

原音の飽和率はLARM調査値としてglass-bell 3.88%、tiny-harp 7.56%、felt-piano 4.43%、soft-sparkle 0.93%、bamboo 2.24%。ほかの5件に飽和がないことも合格の根拠にはしない。原音・加工後のSHA-256と不合格状態を `verification-reports/notification-sounds/quality-review-2026-10-31.json` に記録した。既存音源・選択設定は書き換えていない。

既存のSSH接続を使い、LARMホストから既に生成済みの次の2音だけを取得した。HTTP生成APIは呼んでいない。モデルの起動・再起動、別Codexチャットへの送信は行っていない。

| 候補 | 出自 | ローカルファイル | SHA-256 |
| --- | --- | --- | --- |
| 元promptの5秒候補 | 隔離CPU比較 | `verification-reports/notification-sounds/candidates/soft-chime-cpu-5.wav` | `a73e604c5b322578a21438268297199c12a67f50b57ef31f9601d67ae0a83743` |
| 短い肯定文の5秒候補 | 隔離CPU比較 | `verification-reports/notification-sounds/candidates/simple-bell-cpu-5.wav` | `941d9c6f457cf6a2f322d6363dcabec00517cb8e3dfa6e6e0827651c10ff169a` |

両候補とも5秒、44.1kHz stereo float WAV。リモートとローカルのSHA-256一致、ffprobeによる形式・秒数、ffmpegによる全デコードを確認した。音量調整・切出し・フェード等の加工は一切していない。この機械検査は転送・再生形式の確認だけであり、音質合格判定ではない。今回の環境には音声内容を聴感判定する手段がないため、利用者向けにチャット内で候補音を再生できるよう提示し、音色・ノイズ・歪み・余韻の評価を待つ。

利用者の確認後も先頭1.5秒を自動採用しない。合格した音の必要な区間と余韻を保持して編集する。`task: sound-effect` と `quality: balanced` は維持し、instrumental・languageの追加やhighへの変更を必須対策としない。不合格なら再生成の条件・回数を改めて整理する。10音の一括再生成は行わない。

今回の変更は検証記録の訂正と生成済み候補の取得だけ。製品コード・API・DB・設定・同梱音は変更していないためdomain verifyとブラウザE2Eは再実行していない。差分点検では意味判断を代替するコードの追加なし。今回 context_compile 1回・compile_eval 1回。

## 試聴合格2音の採用計画（2026-10-31）

利用者がA・Bの2候補を「ちゃんとしています」と確認したため、この2音だけを採用する。既存の設定文書・公開ID・音声出力と登録手順を再利用し、Aをsoft-chime（やわらかなチャイム）、Bをglass-bell（澄んだベル）に割り当てる。ほかの8種類は再制作待ちとして新しい設定画面の選択肢から外す。元10音は原音と加工後の両方を検証資料へ保持する。

- ユーザーが聴いた5秒全体と余韻を維持するため、今回は切出し・音量増幅・フェードを行わず、ブラウザ互換のPCM16 WAVへ符号化するだけにする。5秒なら良好という一般化はしない。
- settings.voice-input@9は変更せず@10を追加し、合格2音と従来beepだけを表示する。旧8種のIDは設定文書の互換読取りのため保持する。保存済みの旧選択は「再制作待ち」と表示して試聴を無効にし、利用者が別音を選べるようにする。保存値の自動変更や代替音への自動転送はしない。旧音の本体をWeb配布から除くため、そのIDの音源取得は既存のmissingエラーで失敗し、ビープや未検証音を鳴らさない。
- 既存の制作スクリプトも新規生成を既定で全件・製品音源へ書き込まない形へ限定し、明示した1音だけを5秒・SE・balancedで試聴候補へ保存する。今回は実行せず、残8種の生成は保留する。
- 部分: 原音保持hash、合格候補からのPCM変換・長さ維持、旧IDと設定保存の互換性、旧音源取得拒否。
- 結合: @10の3選択肢、試聴・停止・保存・復元、旧IDの再制作待ち表示と変更、@9不変のbundle check。
- 通し: settings/audio/capabilities verify、対象外のsettings-data試験、型・lint・format、Vite buildで配布音源が合格2音だけであること。ブラウザでは既存の再生チェックを選択可能音だけへ更新して確認する。原音の品質判定を機械試験で代替しない。
- サーバー操作・新規生成・DBや認証・LLMの判断方式は対象外。残作業は実装・上記検証・差分点検。元の約10種類という制作目標のうち残り8種類は未完了として報告する。


## 試聴合格2音の採用結果（2026-10-31）

利用者の「はい。ちゃんとしています」を、直前に提示したA・B両方の試聴合格として記録した。A→やわらかなチャイム（soft-chime）、B→澄んだベル（glass-bell）。両方とも5秒の全サンプル、44.1kHz stereoを維持し、PCM16へ符号化した。切出し・増幅・フェードは行っていない。原候補との差はPCM16量子化の範囲内（最大差0.000015259）である。新規のLARM生成は0件。

不合格の元WAV10件と当初の配布音10件は `verification-reports/notification-sounds/` の原音と `rejected-bundled/` に保管し、前回記録したSHA-256に全件一致することを確認。合格音の出自・hash・利用者の合格発言・変換内容は `adopted-sounds-2026-10-31.json` に保持した。

旧 `artifact:settings.voice-input@9` は本文不変、新しい@10を同じbundleへ追加。選択肢は合格2音と従来beepの3件。旧8音のIDは設定互換性のため受理するが、新規選択肢から除外した。保存済み旧音は「再制作待ち（以前の通知音）」と表示し、試聴を無効にして選び直しを案内する。保存値の自動変更や別音への自動転送はしない。旧8音の本体はWeb assetsから除き、保存済み旧音の取得は既存missingエラーで失敗する。通知の発生条件・表示・保存・既読化の仕様は変更していない。

制作スクリプトは `--run --candidate <id>` で明示した1音だけを5秒・SE・balancedで生成し、日付別の試聴候補ディレクトリへ原音を保存する形にした。製品音源と過去の原音を自動で上書きしない。指定不足時は接続前に停止することを確認した。この停止は検証目的の想定どおりの結果であり、生成失敗ではない。追加生成はしていない。

検証結果:

- 部分: settings APIの互換保存1試験成功。Webの音源取得・取消・不合格音拒否・設定試聴/保存/復元・旧選択からの変更・共通出力3ファイル18試験成功。
- 結合: settings-dataと通知archiveの11ファイル53試験成功。@10のbundle checkはissueなし。@9がHEADと同内容であることを比較確認。
- 通し: `bun run verify -- --domain settings --domain audio --domain capabilities` 成功（backend154試験、Web83試験、境界・型・format・lint・DesignSystem buildを含む）。記録: `verification-reports/runs/2026-10-30T20-45-05-868Z-8a4e3588-06e1-40c8-94b6-fd99a0039a8b/report.json`。初回は別検証の実行ロックで開始しなかった。先行検証の終了を確認してから実行し直して成功した。
- 対象外パスのsettings-data・スクリプトは追加のlintを実施し成功。全体型検査2,808ファイル成功。
- 合格2音のデコード・ブラウザendedまでの再生成功。これは変換と再生接続の確認であり、合格判定は利用者の実聴に基づく。Vite build成功、配布WAVはsoft-chimeとglass-bellの2件のみ。既存のchunkサイズ・background動的import警告は残る。
- サーバーを起動するブラウザE2Eとサーバー再起動は未実施。新しい生成も未実施。既存のtimers→resourcesの境界違反を含む総合検証は前回の担当外失敗として残し、音源・選択肢だけの今回の変更で同じ失敗を再試行していない。
- 差分点検: 音源の品質状態を明示した契約・選択肢・保存互換性の処理だけで、個別発話の意味判断、LLMの判断方式・優先順位・フォールバックを追加していない。並行作業のinference・visual-perception等の差分は保持した。

残作業: 約10種類という当初の制作目標の残り8種類、許可を得た場合のサーバー再起動による反映。今回 context_compile 1回・compile_eval 1回。

## 残8種類の生成依頼（2026-10-31）

利用者が「残りも生成してください」と明示したため、残8種類を試聴候補として順番に生成する。既存スクリプトを再利用し、木琴・水滴・マリンバ・ハープ・ピアノ・きらめき・竹・花ひらく音を各1 POST、5秒・task=sound-effect・quality=balanced・WAVで生成。保存済みLARM接続とcatalogの返却先を使用する。追加のProfile/model固定、high・instrumental・language指定は行わない。各要求の上限は300秒、失敗したPOSTは再送せずその時点で止める。

今回は利用者が8種類の生成を依頼しており、候補作成は8種類まで許可された範囲として進める。HIP本番経路の5秒生成は前回のCPU比較候補と同じ音色を保証しないため、製品へ自動採用せず、原音と生成記録をチャットで試聴できる状態にする。機械検査はWAVデコード・5秒の保持・飽和sampleの有無・原音保全を確認するだけで、通知音としての品質判定に使わない。

残作業: 8候補の生成→原音・artifact ID・hashの記録→デコード/飽和とブラウザ再生の確認→チャットでの試聴提示。製品の音源・設定項目・既存2合格音・サーバー稼働は変更しない。合格確認が必要な音の再生成や置換は今回自動実施しない。


## 残8種類の生成結果（2026-10-31）

依頼された8候補を生成済み。各1 POSTで完了し、自動再送・再生成は0件。すべて5秒、44.1kHz stereo WAV。製品音源へのコピー・上書きはせず、未加工の原音を保持し、チャット試聴用の同一byteコピーを `verification-reports/notification-sounds/remaining-2026-10-31/` に用意した。

順序: 1 木琴の便り（wooden-notes）、2 水滴（water-drop）、3 あたたかなマリンバ（warm-marimba）、4 小さなハープ（tiny-harp）、5 やさしいピアノ（felt-piano）、6 星のきらめき（soft-sparkle）、7 竹の響き（bamboo）、8 花ひらく音（gentle-bloom）。artifact ID、送信条件、返却model/runtime、原音path、SHA-256、機械検査値は同ディレクトリの `manifest.json`、ブラウザ再生結果は `playback.json` に記録。

8音すべてffprobeで5秒を確認し、ffmpegで全デコード、実Chromiumのaudio要素でendedまでの再生を確認した。原音のpeakは約0.133〜0.868、上限に張り付いたsampleは検出されなかった。これらを音質合格の証明とは扱わない。利用者による音色・雑音・歪み・余韻の確認待ちであり、採用済みは従来の2音だけ。

既存合格2音と不合格原音10件は保存済みhashと一致し、変更されていないことを確認。今回は既存スクリプトの実行と検証資料の更新だけで、製品コード・API・DB・設定・LLMへの指示・音源選択肢を変更していない。そのためdomain verifyやアプリのE2Eは再実行していない。`git diff --check` 成功。サーバーの停止・起動・再起動と別Codexチャットへの送信は行っていない。

残作業: 新8候補の実聴評価、合格した候補だけの設定への追加・音源採用、許可を得た場合のサーバー反映。今回 context_compile 1回・compile_eval 1回。

## 残8音の採用計画（2026-10-31）

利用者が「採用していいです。今現在3種類しかないので増やして」と承認したため、試聴済み8原音をそのまま同梱し、合計10生成音＋従来beepの11選択肢へ増やす。既存の選択・試聴・保存・共通音声出力を再利用する。新しいLLM判断・生成・後処理・音量調整・短縮・設定値変更は不要。

変更順: 原音hashを確認して8音を同梱→公開選択肢を11件へ→旧@9/@10本文を保持してsettings.voice-input@11を追加→全選択肢の表示/試聴/保存と以前の選択値tiny-harpの再利用、全10音の取得と取消・形式エラーを確認→bundle check・settings/audio/capabilities verify・settings-data結合・型/lint/format・全音ブラウザ再生・buildの10WAV同梱確認→差分点検。

完了条件は音質合格済みの10音が選べて試聴・保存でき、元原音・既存選択を壊さないこと。稼働中画面への反映は既存の起動時bundle登録とWeb読み直しが必要なため、サーバー再起動の明示許可を得るまでは実装・検証完了と稼働反映待ちを区別する。サーバー操作や他作業の差分への修正は行わない。


## 残8音の採用結果・計11選択肢（2026-10-31）

利用者の「採用していいです。今現在3種類しかないので増やして」を、新8音の採用承認として記録した。新8音は試聴原音とbyte同一のままWeb soundsへコピーし、音量・長さ・余韻・形式を変えていない。既存の合格2音もhash不変。不合格の最初の原音10件は引き続きhash不変で保管。出自と採用の発言、source/product hashは `verification-reports/notification-sounds/all-ten-adopted-2026-10-31.json` に記録。

公開選択肢を11件へ拡張し、`artifact:settings.voice-input@11` を追加した。@9と@10の本文はHEADと比較して不変を確認。旧tiny-harp等も、保存値を変えず試聴可能になる。新規のフォールバックや音量調整はなく、既存の文書・試聴・保存・出力をそのまま使用する。

検証:

- 部分: 実登録JSONで11選択肢を表示すること、全10生成音の取得、試聴/停止/保存/復元、以前のtiny-harp選択の再利用を2ファイル6試験で確認。
- 結合: settings-dataと通知archiveの11ファイル53試験成功。bundle checkはissueなし。
- 全体: settings/audio/capabilities verify成功（backend154試験・Web83試験、静的検査とDesignSystem buildを含む）。記録: `verification-reports/runs/2026-10-30T21-28-11-024Z-eb371d49-8d74-4140-92e6-110b4e6997ad/report.json`。初回は別の検証がロックを保持しており未開始。先行検証の終了確認後に実行して成功した。
- 全体型検査2,808ファイル、対象lint・format・`git diff --check`成功。Vite build成功、配布WAVが10種類であることを確認。既存chunkサイズとbackgroundのimport警告は残る。
- 全10音でWAVデコード、5秒保持、実Chromiumのendedまでの再生を確認。聴感合格の根拠は利用者の採用承認であり、この機械検査ではない。
- 稼働中の認証済みAPIを読み取り専用で確認した結果、`artifact:settings.voice-input@10` がactive、通知音の選択肢は3件だった。起動時登録を行わず未登録の@11をpublishするだけでは反映できず、Webの読み直しも必要。AGENTS.mdのサーバー操作制限に従い、API・Webの再起動は未実施。実装完了・検証済みと稼働反映待ちを区別する。
- 今回は新規生成0件。DBスキーマ・設定値・秘密・通知条件・LLMへの指示・判断方式・フォールバックは変更していない。並行作業のdialogue/inference/steward/larm等の差分は保持した。

残作業: 利用者の明示許可を得てAPI・Webを再起動し、稼働画面の11選択肢と試聴を確認する。今回 context_compile 1回・compile_eval 1回。

## 音声による完了通知の試作（2026-10-31）

利用者が、SEだけでなく「タスク完了しました」「Task has been completed」のような音声通知も欲しい、TTSまたは楽曲生成の声で試したいと依頼した。まず短文をそのまま読ませられる既存TTSで日本語・英語を各1候補生成する。既存LARMのspeakと保存済み接続・声・話速・英語の声の組合せを再利用し、Profile/model/voice名は固定しない。試作後はWAVを保持して試聴提示する。今回は歌唱生成・新規の声のクローン・製品設定値の変更・サーバー操作は行わない。

既存の共通通知音は完了以外の質問・新着等でも鳴るため、固定の完了音声を共通通知へ無条件に差し替えることはしない。今回の完了条件は2言語の試聴候補、生成/形式/再生の確認、利用者による内容確認待ちの明示。採用する声・文面を確認した後に、完了通知への接続範囲を既存通知のイベントと照合して決める。

### 音声通知の試作結果

既存LARMの独立した一時接続で、日本語「タスクが完了しました。」と英語「Task has been completed.」を各1回TTS合成した。日本語は保存済みの声・話速等、英語は既存の日本語の声との組合せ規則と英語Providerを利用した。Profile/model/voice名の固定や設定値の書き換えはしていない。終了時にこの一時接続を解放し、稼働アプリの接続は操作していない。

出力は `verification-reports/notification-sounds/spoken-completion/task-completed-ja.wav`（約1.30秒）、`task-completed-en.wav`（約3.19秒）。24kHz/monoのWAV原音を保持し、加工・切出し・音量調整はしていない。文面・長さ・hash・生成時間・再生結果は同ディレクトリの `manifest.json`。両方とも全デコードと実Chromiumのendedまでを確認した。聴感・発音・声の採用判定は利用者の試聴待ち。

今回の成果は試聴候補2つで、製品の通知音選択肢への登録や通知イベントへの接続は未実施。完了以外の質問・新着で「完了しました」と鳴らさないよう、採用後に既存イベントの責務を確認して接続する。製品コード・API・設定・サーバー稼働を変更していないためdomain verifyは再実行していない。`git diff --check`成功。今回 context_compile 1回・compile_eval 1回。

### 日本語候補を男性音声へ変更

利用者の「つむぎじゃない男性音声にして。日本語は」を受け、保存済み接続の日本語voice catalogを読み、voice_presentation=masculineの候補を確認した。catalogの玄野武宏（ノーマル）を選び、一時的なspeechOverrideで「タスクが完了しました。」を1回再合成した。ID・style・creditは実行時catalogの値を使用。会話全体の声設定と既存の英語候補は変更していない。

新しい候補は `verification-reports/notification-sounds/spoken-completion/task-completed-ja-male.wav`、出自・credit・hash・形式・ブラウザ再生結果は `male-candidate.json`。未加工で保持し、全デコードと実Chromiumのendedまでを確認。日本語の採用候補をこの男性声へ差し替え、利用者の声・発音の試聴確認待ちとする。独立接続は終了時に解放済み。製品コード・設定値・サーバー稼働は変更なし。既存TTS操作での単純な声変更・再合成のため、今回context_compile/compile_evalは各0回、domain verifyは再実行していない。

### 英語候補も男性音声へ変更

利用者の「英語の方も男性音声にして」を受け、日英の実行時voice catalogを読み、日本語の男性候補と既存の英語ペアリング規則から男性声Jasperを選択した。voice_presentation=masculineを確認して「Task has been completed.」を1回合成。一時的なspeechOverrideだけを使用し、日本語の男性候補・会話全体の声設定は変更していない。

音声は `verification-reports/notification-sounds/spoken-completion/task-completed-en-male.wav`、出自・voice metadata・hash・形式・ブラウザ再生結果は `english-male-candidate.json` に保持。未加工WAVを全デコードし、実Chromiumでendedまでを確認。声・発音の採用判定は利用者の試聴待ち。独立接続は解放済み。製品コード・設定値・サーバー稼働は変更なし。既存TTSによる単純な再合成として今回context_compile/compile_evalは各0回、domain verifyは再実行していない。

## 男性の完了音声2種の採用計画（2026-10-31）

利用者が「この２つで良いです。通知音に追加してください」と、日本語・英語の男性候補を承認した。既存の通知音に加えて声でも知らせたいという依頼に従い、通常の通知音11選択肢は維持し、同じ通知音の設定区画に「タスク完了時の音声」（音声なし・日本語男性・英語男性）を追加する。通知音に続けて採用済みWAVを再生し、毎回TTSを生成しない。

- voice.completionVoiceを任意保存する。未保存・noneでは既存SEだけ。ユーザーの既存の選択や会話の声は自動変更しない。
- @11本文を保持してsettings.voice-input@12を追加し、既存select・文書下書き・適用・試聴actionを再利用。試聴は保存前の音声を既存音量・出力先で鳴らし、選択変更・停止・画面を閉じると中止する。SEと声の試聴は互いに止める。
- 男性候補2WAVを未加工・byte同一で同梱。loaderとaudioの共通出力を再利用し、完了用の再生口でだけSEの後に声を再生する。取得失敗・取消で別の声やビープへ自動転送しない。
- 成功の根拠は通知の既存状態に限る。TODOはoutcome=succeeded、Kanbanはkind=doneの新しい未読通知がある場合に完了用再生を呼ぶ。失敗・中断・一部完了・質問・待機・工程完了・タイマー・初期読込・既読済みでは完了音声を鳴らさない。terminalのidleは成功を保証する契約ではないため通常SEを維持する。文面の語句から成功を推測しない。
- 通知の発生条件・保存・既読化・重複抑制は維持し、既存のSEに音声を追加するための状態フラグだけを通知の利用側へ渡す。LLMの判断方式・優先順位・フォールバック・新規生成は追加しない。

実施順と完了条件: 原音hash/creditの確認と同梱→設定契約と@12→共通出力と成功通知の接続→部分（保存互換・不正ID・音声取得・SE後の再生/取消/音量）→結合（実登録JSONの音声選択/試聴/停止/保存/復元、成功・失敗・確認・初期読込の差）→settings/audio/kanban/dialogue/capabilities verifyと対象外settings-data/workspaceの試験、型・整形・lint・build・同梱音再生→差分点検。既存の担当外違反は修正しない。サーバー操作は明示許可がないため対象外とし、稼働反映待ちを実装・検証と分ける。


### 男性の完了音声2種の採用結果

@12に「タスク完了時の音声」の3選択肢（音声なし・日本語男性・英語男性）と専用の試聴/停止ボタンを追加した。通常の通知音11選択肢は維持。旧設定ではcompletionVoiceが未保存のため音声なしとなり、通常SEだけで従来どおり動く。利用者が選んで保存した声だけを、成功が明示された通知のSEの後で再生する。保存前の試聴は選んだ声だけを再生する。UIに日本語のcredit（VOICEVOX:玄野武宏）と英語の声名を表示する。

日本語・英語の男性原音はbyte同一で同梱し、生成・加工・増幅・切詰めは0件。採用承認とhash・creditを `verification-reports/notification-sounds/spoken-completion/adopted.json` に記録した。@9/@10/@11の本文がHEADと同一であることを比較確認。

既存成功通知の契約をコードで引き継ぎ、TODOのsucceededとKanbanのdoneが新たに未読で届いたときだけ完了音声を追加する。初回読込・同じsnapshot・既読・failed/partial/interrupted・質問/待機/工程完了などは声なし。terminalのidleは成功を保証しないため通常SEだけ、タイマーは従来のSEとタイマー固有の読み上げを維持。語句や通知本文を見て成功を分類する処理はない。既読化・通知保存・バナー・通知件数は変更していない。

実装は既存のbundle・設定文書・WAV loader・audio controllerを再利用。workspaceの音声接続だけを小さい `useNotificationAudio` にまとめ、実通知hooksと同じ接続を結合試験で使う。マイク抑制・音量・出力先・取消を共有し、SE終了前に完了音声を開始しない。SEと声の試聴は互いを停止し、選択変更・画面終了でも停止する。

検証結果:

- 設定APIの旧文書互換・3値保存・不正URL拒否の2試験、35assert成功。
- 部分試験では、通知hooksの最初のqueryが反映される前に状態を更新していた新試験2件が失敗した。製品側を変えず、既読の初期通知が読み込まれたことを待ってから新着を流す手順へ修正し、2ファイル8試験成功。期待する成功/失敗の条件は弱めていない。
- 部分＋結合は16ファイル82試験成功。実登録JSONの選択/試聴/停止/保存/復元、SE→声の順序、途中取消、既存の通知hooksを通す成功・質問・重複snapshot・タイマー、live TTSが呼ばれないことを確認。
- @12のbundle checkはissueなし。
- `bun run verify -- --domain settings --domain audio --domain kanban --domain dialogue --domain capabilities`: 成功。backend629試験、Web123試験、依存境界・型・整形・lint・DesignSystem build成功。記録: `verification-reports/runs/2026-10-31T04-58-15-207Z-f123eb1c-9c9f-4da3-8ac6-e5657f1b861f/report.json`。
- 対象外のsettings-data/workspaceを含む全体型検査2,678ファイルと対象lint成功。Vite build成功、12 WAV（10SE＋2音声）の同梱を確認。全12音でデコード・実Chromiumのendedまでの再生を確認した。聴感合格の根拠は利用者の承認である。
- 作業中に以前の一時確認用スクリプト `scripts/notification-sounds-check.ts` が現在のcheckoutにないことが分かったため、そのスクリプトは復元せず、検証資料側の一時実行で同梱12音の再生を確認した。製品機能の専用実装を追加する理由にはしていない。
- 新しい生成・サーバー操作・DBスキーマ・会話の声設定・LLM指示・優先順位・フォールバックは変更なし。差分点検では個別発話や文言で意味判断を代替する処理なし。並行作業の音楽プレイヤー・terminal・harness等の差分は保持。

今回の採用・設定・成功通知への接続は実装/検証済み。残作業はサーバー再起動の明示許可を得た場合の稼働反映と実画面の受入。用途別の「確認してください」「エラーが発生しました」等の追加バリエーションは提案に留め、生成・実装はしていない。今回 context_compile 1回・compile_eval 1回。
