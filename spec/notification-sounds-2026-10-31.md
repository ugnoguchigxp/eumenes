# 通知音の選択と試聴

2026-10-31の利用者依頼に基づく追加。既存の通知条件、LLMの指示・判断、writer・設定API・共通下書き・音声出力を維持し、LARMで制作した10種類の短い通知音を同梱する。

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

- 10音は各1.5秒、24kHz/mono/PCM16 WAV。LARM catalogが返したサービスdescriptionを確認し、既存gatewayへ各1 POSTで生成。取得後に音量と両端のフェードを調整。同梱合計720,780 bytes。10音すべて異なるファイルで、実ブラウザのAudioContextでデコード、audio要素でendedを確認。peak 0.129〜0.491、無音・クリップなし。内容の実スピーカー聴取とは区別する。
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
