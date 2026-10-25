# Docling Desk連携の受入記録

2026-10-25。入口とツールチェーンを実装し、gnosisへの実接続と実ブラウザで文書の取り込み・閲覧を確認した。Docling domainのverifyは成功。利用側・全体のgateには、同時進行している別変更による未解決事項がある。全体検証済みとは扱わない。

## 実装と責務

`docling-desk.bundle.json`にprofile、実行用Skill、tool、package、toolchain、binding、Artifactを登録した。既存のSystemContext合成、command担当、domain adapter、結果参照、OpenUI rendererを使う。`docling_desk`から`docling.open`を呼び、`ready_for_open`と`artifact:docling.workspace@1`を返す。モデルにはticket、Cookie、資格情報を渡さない。文書の取り込み・変換・閲覧はDoclingの既存画面で行う。

アーティファクトは既存の説明部品と、新しいDesignSystemの`ExternalAppLauncher`をJSONで組み合わせる。新部品は表示とクリックだけを担当する。業務APIはWeb adapterから専用clientへ接続する。

クリック中に別タブを確保してから、認証付き`POST /api/docling/ui-tickets`を一回要求する。gatewayのticket要求自体が必要時の起動を含む。Eumenes独自の起動ジョブ、起動待ち画面、永続launch台帳、状態poll、leaseは追加していない。要求中はボタンの「接続しています…」だけを表示する。上流190秒・当該HTTP要求200秒の上限を設定した。Bun実サーバーの既定1秒を超える応答試験でも、要求単位のtimeoutが有効であることを確認した。

専用実装は、Doclingの相対ticket URL・60秒・一回限り・Hostの外部契約、秘密を永続化しない要件、popup確保、取消後の不採用のために限定した。発話の語句・題材をコードで分類する分岐は追加していない。URL/tokenの形式検査は外部契約の検証である。

## 保存設定と実行環境

| 用途 | 実際の設定・状態 |
| --- | --- |
| LARM Control | settings公開読み取りの保存済み`http://192.168.0.130:9810`を使用。既存backend資格情報を再利用 |
| backend gateway | `http://127.0.0.1:28765` |
| ブラウザorigin | `http://localhost:28765` |
| gateway Host | backendは`127.0.0.1:28765`。ブラウザは`localhost:28765` |
| SSH | 既存`gnosis`認証でMac loopbackの28765をgnosis loopbackの28765へ転送。LANへ公開していない |
| 通常Eumenes | API8787・Web5173。Docling設定revision1、資格情報設定済み、launcher1件を公開APIで確認 |
| 隔離Eumenes | API8877・Web5273、一時DB。保存済みの公開LARM設定を設定APIで適用。製品DBや秘密はコピーしていない |

Docling設定は既存settings公開操作で保存し、新しいキーやLARM接続先の再入力を要求していない。保存対象は非秘密URLとrevisionだけ。実際の公開設定は[live-settings.json](live-settings.json)。隔離Eumenesを停止・起動した後もrevision1と入口が維持された。

## 固定試験

製品差分・fixtureを揃えた後、部分→結合→ブラウザの順で実施した。

| 試験 | 結果・対象 |
| --- | --- |
| `verify --domain docling` | **pass**。境界、SystemContext、容量、format、lint、DesignSystem型/build、型closure、Bun6件、Web3件、部品1件 |
| Docling・settings・applicationのBun試験 | 10件成功、70 assertions。API認証・Origin、no-store、要求単位timeout、登録から会話の結果参照まで |
| Web helper＋Artifact composition | 4件成功。同期popup、取消、popup拒否時POSTなし、不正origin拒否、JSON組合せ、URL props拒否 |
| DesignSystem | 1件成功。表示・操作・無効状態 |
| ブラウザfixture | 3件成功。実Web adapter＋client＋Artifact host、別タブ、303、Secure/HttpOnly/SameSite=None Cookie、重複抑止、認証失敗、popup拒否 |
| 利用側の固定試験 | settings・capabilities・tool-runtime・agent-runtime・dialogueのBun712件とWeb38件が全て成功 |

domain試験には、HTTPを送らないstatus/prepare、一回だけの上流POST、HostとBearerの契約、重複拒否、URL/期限/応答サイズ、401/403・redirect・ネットワーク失敗の安全なエラー、取消・設定変更後の遅延結果破棄、timeout後の明示再操作を含む。失敗を自動再送しない。

共有ツリーでは検証中に別作業の入力が変わり、2回の検証がinvalidatedになった。成功と数えていない。検証専用コピーを`/tmp/eumenes-docling-verification`へ作り、環境ファイル・製品DB・秘密を除外し、依存ライブラリを読み取り参照した。新しい作業ブランチは作成していない。最終Docling verifyの開始/終了revisionは一致し、DesignSystem出力も消費後まで一致した。並行変更の音楽公開定義が修正された証拠を得た時点でコピーを一度更新し、最終確認した。

ブラウザfixtureはlocalhostの専用ランダムportを使い、実Doclingへ接続しない。初期のroute fixtureでredirect後の通信が実28765へ流れたため、HTTPサーバーを分離して修正した。その時点の起動を、Eumenesからのcold起動成功とは扱っていない。

## live APIと実ブラウザ

実ブラウザはCodex内蔵ブラウザで確認した。認証画面へキーを入力せず、Eumenesのボタンから新規タブへ遷移し、Doclingを操作した。frame保護ヘッダー、Cookie属性、Origin検査を変更していない。Macのlocalhostに対するSecure Cookieの受入を実際の継続閲覧で確認した。他のブラウザ製品・別PCは今回の受入対象外。

| 受入条件 | 観測結果・証拠 |
| --- | --- |
| 停止からEumenes経由で起動 | Controlがstopped/generation5を返した後、ボタンから別タブへログイン。generation6でライブラリ4件を確認。[停止観測](live-idle.json)、[再起動後一覧](live-restart-library.png) |
| 追加キーなしのログイン | ticket発行後、ブラウザが交換して画面を表示。backendは利用者用ticketを交換していない |
| Word取り込み・閲覧 | 合成Wordを実画面のファイル選択から追加。success、原本Wordプレビュー内の識別文と本文を表示。[画像](live-word-preview.png) |
| PDF OCR | テキスト層のない合成PDFを実画面から追加、local OCRでsuccess。PDF原本と抽出文、OCR確認コード48271を表示。[原本](live-pdf-preview.png)、[OCR結果](live-pdf-ocr.png) |
| 無通信後の停止 | Doclingタブを閉じ、Controlだけを15秒周期で観測。2回目は約181秒でstopping、約196秒でstopped。通常APIやjobsを停止監視へ使っていない。[記録](live-idle-retention.json) |
| 文書・ログイン保持 | generation6の停止後、新ticketを発行せずブラウザで通常入口を開いた。以前のCookieで資料4件とWord本文を表示。Controlでgeneration7を確認。[画像](live-cookie-retention-word.png) |
| Eumenes設定保持 | 隔離Eumenes再起動後もDocling設定revision1、launcher1件、開くボタンを確認。[画像](live-artifact-restarted.png) |
| 認証失敗 | 独立した試験用の不正Bearerは401。fixtureでもEumenesに安全なエラーを表示 |
| ticket再利用・期限切れ | 独立した試験用ticketは初回303、同じticketの再利用401。別ticketを61秒経過後に交換して401 |
| 入力上限 | 50MiB＋1byteの合成ファイルは413。POSTを再送していない |
| failed | 破損合成PDFはfailed、errorあり。実画面の失敗表示も確認。[画像](live-failed.png) |
| partial | 合成TeXはpartial、warning1件、TeX errorあり。実画面でTectonic未設定の理由とソースを表示。[画像](live-partial.png) |

APIの詳細は[live-negative.json](live-negative.json)。ticket/Cookie値、Bearer、auth URL、HAR/traceを証拠に保存していない。受入中のEumenesログについて、実資格情報・ticket query・Docling Cookieが含まれないことも値を出力せず確認した。

文書は非秘密の合成試験データだけを追加した。Word job=`f039761e097a42d6bbd78dda0de018b3`、PDF job=`565ae06198bd47fba7ebd856299b8420`。failed/partialを含む4件は受入証拠としてDoclingの共通ライブラリに残した。既存文書の変更・削除、gnosisの文書DB/ファイルの直接操作は行っていない。

cold起動時のブラウザ操作ツールには10秒のnavigation待ち切れが一回あった。そのタブを作り直したり要求を再送せず、同じタブで読み込み完了と本文表示を確認した。これはEumenesが短いtimeoutで重複起動した結果ではない。cold/warmの正確な性能比較は実施していない。

## 実モデル

通常Eumenesの公開APIから、専用の非秘密な受入会話で「Docling Deskを開いて。文書の取り込みと閲覧に使う入口を出してください。」を一回送信した。保存済みLARMを用いた実モデルが`docling.desk@1`を選択し、command担当の推論、処理完了、selectionのcompletedを確認した。runId=`93c233b5-27b8-4285-8506-a176f8687ee7`。詳細は[live-model.json](live-model.json)。途中の共通会話契約の補正とLARM接続失敗1件は通常ログで確認し、最終選択は成功した。

固定モデルの結合試験は、profile＋Skillの合成、`docling.open`一回、`ready_for_open`の結果参照まで確認する。実モデル一件から12ケース全体の意味判断の正しさは保証しない。[行動評価12件](../../design/docling-desk-2026-10-25/behavior-evals.json)の一括モデル評価は未実施。

## 全体gateと未対応事項

利用側はsettings、capabilities、tool-runtime、agent-runtime、dialogue、artifactを選択した。最終の組合せverifyは今回編集していない`settings/test/settings.test.ts`の既存サイズ超過（1143→1218行）で停止。artifact verifyは共有の`composition-fixer.ts`827行、`contracts.ts`859行、`ui-studio-components.tsx`974行のサイズ超過で停止した。`contracts.ts`は今回も登録契約を追加した共有ファイルで、着手前の差分にも800行超過がある。他機能を含む大きな分割は行っていない。全体verifyは今回編集していない`api/application/work/dots-delegation-registration.test.ts`がcapabilities公開入口を迂回する境界違反で停止した。要求・テスト期待値・gateを弱めて通していない。

途中の固定コピーでは音楽の`musicPlaybackPlanV2`がvalidatorへ登録されておらず、利用側691件中10件がseed時に失敗した。並行作業で公開定義が更新され、再起動できることを確認後、最終の利用側試験を実施し、Bun712件・Web38件が成功した。試験用Eumenesの最初の再起動失敗も同じ音楽公開定義の不足だった。今回の範囲外として変更せず、失敗と復旧を区別している。

通常ツリーの最終型検査には別変更の2件が残った。`api/application/server-services.ts:274`の`createAgencyWork`呼出しに必要なresourcesと、`scripts/response-decision/cache-input.ts:135`のDocumentRefs.resourceが不足する。Docling追加部分の型エラーは解消し、固定コピーでのDocling型closureは成功している。

文書は共通ライブラリであり、利用者別分離・Eumenes logoutとの連動失効は未実装。SSH中継が切れた場合の自動再接続や常駐化、Docling LAN入口、HTTPS公開入口、iframe埋め込み、モデルからの文書操作も今回の対象外。表示中のDocling自身の定期通信は自然停止を遅らせるため、タブを閉じた無通信状態で受入した。

OCRはTesseract。別配備のocr-hostをDoclingへつなぐadapterは未実装で、接続済み表示を追加していない。Azure OCR、翻訳・解説、embedding、Blob、TeX組版は機能診断の未設定状態を保持した。

画面案は保存済みLARMのcatalog発見と画像生成で2案作成・目視確認した。第2案の起動待ち専用パネルは利用者の補足で撤回し、実画面は上記ブラウザ画像で確認した。生成画像を完成画面の証拠には使っていない。

## 最終点検

既存の別チャットへ送信せず、新しい作業ブランチを作らず、gnosisのLARM/gateway/systemdを再起動していない。別作業の差分は保持した。意味分類・個別発話への分岐は追加せず、外部契約の検証と接続だけを専用化した。最終の試験結果と公開設定はこのディレクトリへ保存する。全体gateの再確認には上記の担当外変更の解消が必要。

[checks.json](checks.json)に試験集計、[verify-docling.json](verify-docling.json)に成功した正式レポート、[verify-consumers.json](verify-consumers.json)・[verify-artifact.json](verify-artifact.json)・[verify-all.json](verify-all.json)に停止したgateの結果を保存した。[source-manifest.json](source-manifest.json)でDocling専有ファイルと検証コピーの一致を確認した。context_compileは会話累計3回、compile_evalも3回。

終了時は隔離Eumenes（8877/5273）を通常終了した。通常Eumenes（8787/5173）とloopback SSH中継は稼働中。DoclingのWord閲覧タブを利用者向けに残した。SSHの常駐化・OS起動時の自動開始は行っていない。
