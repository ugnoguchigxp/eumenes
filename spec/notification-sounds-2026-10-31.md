# 通知音の選択と試聴

2026-10-31の利用者依頼に基づく追加。既存の通知条件、LLMの指示・判断、writer・設定API・共通下書き・音声出力を維持し、LARMで制作した10種類の短い通知音を同梱する。

> 現在の状態（2026-10-31更新）: 最初の10音は実聴で全件不合格として原音・加工後を保管。利用者が5秒候補A・Bを試聴合格と確認したため、この2音のみを採用した。合格2音と従来ビープを選べる新版設定画面を実装・検証済み。残る8種類の制作と稼働サーバーへの反映は未完了。以下の当初の機械的な検証記録は音質合格の根拠ではない。


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
