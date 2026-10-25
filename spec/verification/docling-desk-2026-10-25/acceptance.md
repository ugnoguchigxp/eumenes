# Docling Desk連携の受入記録

2026-10-25。入口とツールチェーンを実装し、gnosisへの実接続と実ブラウザで文書の取り込み・閲覧を確認した。Docling domainのverifyは成功。利用側・全体のgateには、同時進行している別変更による未解決事項がある。全体検証済みとは扱わない。

同日、利用者から共有されたDocling側レビューと、その後の修正結果報告を反映した。解説の事前判定と汎用warnings表示の2件は、Docling側でコード修正・隔離fixture検証済みとの報告。配備・frontend配信資産更新・実接続・実ブラウザ再受入は未実施。Eumenes側で修正済みの3件と、以前の実接続成功は分けて保持する。この記録反映は文書更新のみで、コード・設定・配備・サービス状態を変更せず、SSH接続・実接続試験も行っていない。

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
| 対象通信・処理・leaseがなくなった後の停止 | Doclingタブを閉じ、Controlだけを15秒周期で観測。2回目は約181秒でstopping、約196秒でstopped。これは当時の観測値で、固定の停止時間ではない。通常APIやjobsを停止監視へ使っていない。[記録](live-idle-retention.json)。今回のレビューでは再実施していない |
| 文書・ログイン保持 | generation6の停止後、新ticketを発行せずブラウザで通常入口を開いた。以前のCookieで資料4件とWord本文を表示。Controlでgeneration7を確認。[画像](live-cookie-retention-word.png) |
| Eumenes設定保持 | 隔離Eumenes再起動後もDocling設定revision1、launcher1件、開くボタンを確認。[画像](live-artifact-restarted.png) |
| 認証失敗 | 独立した試験用の不正Bearerは401。fixtureでもEumenesに安全なエラーを表示 |
| ticket再利用・期限切れ | 独立した試験用ticketは初回303、同じticketの再利用401。別ticketを61秒経過後に交換して401 |
| 入力上限 | 50MiB＋1byteの合成ファイルは413。POSTを再送していない |
| failed | 破損合成PDFはfailed、errorあり。通常時の実画面の失敗表示を確認。[画像](live-failed.png)。通信messageとの併記は未受入で、後述の改善候補 |
| partial | 合成TeXはpartial、APIのwarnings1件とTeX errorあり。実画面で確認したのはTectonic未設定に関するTeX固有の組版失敗理由とソース。[画像](live-partial.png)。汎用warningsの画面表示が成功した証拠とは扱わない。その表示欠落は後にDocling側でコード修正・fixture検証済みとの報告を受領したが、配備・実ブラウザ再受入は未実施 |

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

文書は共通ライブラリであり、利用者別分離・Eumenes logoutとの連動失効は未実装。SSH中継が切れた場合の自動再接続や常駐化、Docling LAN入口、HTTPS公開入口、iframe埋め込み、モデルからの文書操作も今回の対象外。Doclingの共有更新検知に必要な定期通信が続く間は、無操作でも停止条件を満たさない。初回はタブを閉じた後に停止を観測した。対象通信・処理・leaseがなくなった後に停止するという説明を使う。

OCRはTesseract。別配備のocr-hostをDoclingへつなぐadapterは未実装で、接続済み表示を追加していない。Azure OCR、翻訳・解説、embedding、Blob、TeX組版は機能診断の未設定状態を保持した。

画面案は保存済みLARMのcatalog発見と画像生成で2案作成・目視確認した。第2案の起動待ち専用パネルは利用者の補足で撤回し、実画面は上記ブラウザ画像で確認した。生成画像を完成画面の証拠には使っていない。

## 最終点検

既存の別チャットへ送信せず、新しい作業ブランチを作らず、gnosisのLARM/gateway/systemdを再起動していない。別作業の差分は保持した。意味分類・個別発話への分岐は追加せず、外部契約の検証と接続だけを専用化した。最終の試験結果と公開設定はこのディレクトリへ保存する。全体gateの再確認には上記の担当外変更の解消が必要。

[checks.json](checks.json)に試験集計、[verify-docling.json](verify-docling.json)に成功した正式レポート、[verify-consumers.json](verify-consumers.json)・[verify-artifact.json](verify-artifact.json)・[verify-all.json](verify-all.json)に停止したgateの結果を保存した。[source-manifest.json](source-manifest.json)でDocling専有ファイルと検証コピーの一致を確認した。context_compileは会話累計3回、compile_evalも3回。

初回の実接続受入終了時は隔離Eumenes（8877/5273）を通常終了し、通常Eumenes（8787/5173）とloopback SSH中継、DoclingのWord閲覧タブを残した。これは当時の状態であり、現在の稼働保証ではない。後続のEumenesコードレビューでは前回の中継プロセスの終了を確認し、再接続していない。現在の指示ではSSH接続、配備変更、サービスの起動・再起動を行わない。SSHの常駐化・OS起動時の自動開始も行っていない。

## Docling側レビューの反映（2026-10-25）

出所は利用者がこの会話で共有したDocling側のレビュー結果。以下の仕様・原因・隔離試験結果はDocling側の報告として記録し、Eumenesから独立に再検証したとは扱わない。当初のレビュー段階ではDocling側もコード・配備・サービス状態を変更していなかった。その後のコード修正・fixture検証の報告は末尾へ追記し、下表の2件の状態を更新した。修正や通信間隔変更が配備済みとは記録しない。

### 確認済み・修正済みの範囲

| 区分 | 状態 |
| --- | --- |
| 以前のEumenes実接続受入 | 別タブログイン、Word取り込み・閲覧、画像PDFのTesseract OCR、対象通信終了後の停止、再起動後の文書・Cookie保持は確認済み。既存の画像・JSON記録を維持する。今回再実施したものではない |
| Eumenes側のコードレビュー | 設定変更通知、古い接続要求の取消、競合理由表示の3件は修正済み。固定試験・ブラウザfixtureの結果は[review.md](review.md)。これらをDocling側の未修正事項へ戻さない |
| Docling側の当初レビューの隔離検証 | 認証・診断テスト42件、通信間隔の判定11条件が通過したとの報告。Eumenes側の試験件数へ合算しない。後述の修正後試験へも含めない |
| 現在も未実施 | 非表示タブの実ブラウザ試験、以前の約196秒の停止受入の再実施、2不具合の配備後の実接続・実ブラウザ再受入。修正後の隔離fixtureは末尾の報告で区別する |

### 修正担当と未完了事項

担当は責務の割当であり、別タスクへの依頼送信や実装の開始を意味しない。

| 項目 | 分類・担当 | 確認内容・必要な対応 | 状態 |
| --- | --- | --- | --- |
| 解説の事前判定の不整合 | 確認された不具合。Docling backendのoverview/provider事前確認、画面表示はDocling frontend | 修正前は認証未設定でもoverviewの`configuration_error=null`となり生成POSTへ進んだ。報告された修正は診断と同じローカルpreflightと案内文の共通化、生成前の理由表示、自動生成・再試行・再生成POSTの抑止。保存済み解説の閲覧・Markdown/JSON書き出しは維持 | Docling側報告：コード修正・fixture検証済み。配備・実接続再受入待ち |
| 汎用warningsの表示欠落 | 確認された不具合。Docling frontendのJob型と結果表示 | 修正前は保存・APIにあるwarningsの型と表示処理がなかった。報告された修正はJob型・応答形式検査・共通文書ビューアーの表示追加。TeX固有理由とは別表示し、failed/error・原本・ソース閲覧を維持 | Docling側報告：コード修正・fixture検証済み。配備・実ブラウザ再受入待ち |
| failed理由と通信状態の併記 | 改善推奨。Docling frontend | failedのerrorは通常表示される。通信エラー等のmessageが優先される間は保存済みの理由が隠れるため、通信状態と保存済みerrorの併記を推奨する | 提案、未実装 |
| 翻訳入口の未設定表示 | 改善候補。Docling frontend | 現行のダイアログは設定不足を示して開始を防ぐ。入口の時点でも未設定と分かる表示を検討する | 提案、未実装。開始制御の不具合とは扱わない |
| 停止条件の説明統一 | 記録・説明の修正。Eumenes文書担当、Docling側文書・画面説明の担当 | 対象通信・処理・leaseがなくなった後に停止する、と説明する。無操作だけを停止条件としない。約196秒を固定時間としない | この記録とEumenesの利用説明を更新。Docling側への反映は未確認 |
| 処理なし時の通信を30秒へ延長 | 仕様変更案。Docling frontend、共有更新・停止方針は関係担当と設計合意 | 変換中2秒を維持し、処理なし30秒、表示復帰時・更新操作後に即時取得する案。共有更新の検知は最大約30秒遅れる。この案でも表示中の定期通信は続く | 設計合意待ち。実装しない |
| 表示中でも自動停止させる | 別仕様の設計。Doclingの監視・停止方針の担当 | 30秒への延長だけでは実現しない。監視を止める条件と共有更新検知・表示復帰の扱いを別途決める必要がある | 未合意・未実装 |
| ocr-host連携 | 追加開発。Docling連携担当を主担当とし、ocr-host/LARM担当と契約調整 | 下記の契約・受入条件を先に決める。現行のTesseractを共有OCR接続済みと扱わない | 未着手。今回adapterを追加しない |

### 定期通信・停止の現行仕様

Docling側報告による通信間隔は、queued/runningがある間は約2秒、処理がないlibraryモードでは約5秒。後者は別タブ・別利用者による共有ライブラリ更新の検知が目的で、不具合ではない。文書閲覧もlibraryモードなので約5秒通信が続く。非表示タブでは定期取得を抑制する仕様であり、その実ブラウザ受入は今回未実施。

ローカル設定はgatewayの無通信判定60秒・判定周期15秒、管理側の停止待ち120秒。以前の約196秒という観測とは整合するが、判定周期、対象通信、処理、leaseの状態に依存し、60＋120秒または196秒で必ず停止するという保証ではない。進捗確認の通信と、変換中の処理数を管理側へ知らせる停止保護は別の役割。通信を減らす案で停止保護を置き換えない。

### 不具合と断定しない未設定機能

以下はDocling側レビューで開始制御に不具合を確認していない事項。未設定機能が利用可能になったことや、Eumenesで再受入したことを意味しない。

| 機能 | 現行の制御・残す機能 |
| --- | --- |
| Azure OCR | 未設定時は選択不可。現行providerは`local / azure_read / disabled`で、LinuxのlocalはTesseract |
| 翻訳 | ダイアログで設定不足を表示し、開始不可。入口でも未設定と分かる表示は改善候補 |
| embedding | 意味検索・複合検索は選択不可 |
| Blob | 任意の未設定機能として表示。ローカル保存は継続 |
| TeX | ソース閲覧を維持し、組版失敗理由を保持。PDF未生成なら組版表示は選択不可 |

解説はこの表の開始制御正常という当初レビューの判定に含めない。overview不整合はコード修正・fixture検証済みとの後続報告を受けたが、配備後の実ブラウザ受入は未実施である。

### ocr-host追加開発の着手条件

開発前に、入力・出力・座標の契約、gateway接続先と資格情報の供給方法、timeout・同時実行数、受付不明時の重複送信防止、再試行・取消・フォールバック、partial/failedの扱い、原本版とキャッシュの対応を決める。上流に冪等作成があると仮定してPOSTを再送しない。資格情報の供給方式も未確定の契約事項として扱う。

受入には契約試験、日本語・英語・回転画像、座標照合、障害・重複要求・再起動、資格情報非露出の検証が必要。契約と設計が合意されるまでadapter実装や接続済み表示を追加しない。

### 修正後・仕様変更後の再受入条件

現時点では再受入を開始しない。実施する場合は対象のコード版・配備版と設定、固定試験・live API・実ブラウザの別、変更した条件を記録する。SSH接続、配備変更、サービスの起動・再起動の禁止は継続する。これらを必要とする手順には進まない。

1. **解説修正**：修正済みbackendとfrontend配信資産を同じ版へ反映した後、認証設定あり/なし×保存済み解説あり/なしの4条件を実ブラウザで確認する。診断・overview・画面の新規生成可否と理由が一致し、認証なしでは自動生成・再試行・再生成のPOSTを抑止すること。保存済み解説の取得・閲覧・Markdown/JSON書き出しを維持すること。設定済み条件では実際の通常生成・再生成を回帰確認する。事前確認で外部認証・生成APIを呼ばないことも確認する。
2. **warnings修正**：APIと保存済み結果にあるwarningsがJob型を通って実画面に表示され、partialの理由・変換上の注意事項を確認できること。欠落・空・複数件、実ブラウザの再取得・再読込後の表示、HTML風文字列の安全なテキスト表示、TeX固有理由との別表示を確認する。failedの既存errorと原本・ソース閲覧も回帰確認する。jsdomとfixture応答の成功だけで実ブラウザ受入済みとは判定しない。
3. **任意の表示改善を採用した場合**：failed理由の併記では、通信エラー等のmessageがある間も保存済みfailed/errorを確認でき、通信回復後も結果が変わらないこと。翻訳入口の未設定表示を採用する場合は、入口とダイアログの説明が一致し、未設定時に開始不可の制御も維持すること。
4. **通信・停止**：現行仕様の非表示タブで定期取得が抑制されることを実ブラウザで確認する。通信間隔案を採用する場合は設計合意後に、queued/runningの約2秒、処理なし約30秒、表示復帰・更新操作後の即時取得、共有更新検知の最大約30秒への遅延を確認する。変換中の停止保護と進捗取得を別々に検証する。対象通信・処理・leaseがなくなった後の停止はControlだけで観測し、条件と経過を記録する。約196秒を合否の固定閾値にしない。表示中の停止は別仕様を合意した場合だけ受入対象とする。
5. **Eumenes連携の回帰**：関連するDocling修正が反映された版で、別タブログイン、Word取り込み・閲覧、PDF OCR、停止後の文書・Cookie保持を再確認する。以前の成功記録を今回の再試験結果として使い回さない。Eumenes側の修正済み3件は既存の固定試験で回帰確認する。
6. **OCR連携を別途実装する場合**：上記の合意済み契約と専用受入一式を使い、今回の2不具合修正や既存Tesseractの成功とは別に判定する。

全ての再受入で通常通信の入口28765を維持し、本体28766を入口にしない。UI-ticketの60秒・一回限り・303、CookieのSecure/HttpOnly/SameSite=None属性、frame保護、gatewayによるleaseと起動停止管理を維持する。Bearer・ticket・Cookieをログ・会話へ保存しない。文書は共通ライブラリであり、利用者別分離を保証しない。

本追記の確認対象は文書の差分・記録の整合・ローカルリンク・空白エラーのみ。文書だけの変更であり、製品試験や非表示タブ・停止の実接続受入は実行しない。Docling側から報告された42件・11条件は提供された結果として記録する。

## Docling側の修正結果報告（2026-10-25）

利用者から共有された後続報告を反映した。以下はDocling側のコード修正と隔離fixture検証の報告であり、この記録作業でDoclingのコード・QA資料を直接閲覧・検証した結果ではない。

### 状態と担当

| 段階 | 状態・出所 |
| --- | --- |
| Doclingコード修正 | 2件とも修正済みとの報告。コード反映先は`/opt/docling-desk`。コード反映先の記載だけで稼働版や配信資産への反映を保証しない。commit/hash等の版識別子は未提示 |
| 隔離fixture検証 | 下記の修正後試験が成功したとの報告。Eumenes側では再実行していない |
| 配備・frontend配信資産更新 | 未実施。修正済みbackendとfrontendを稼働環境へ同じ版で反映できたとは扱わない |
| 実接続・実ブラウザ再受入 | 未実施。実認証・実生成・ブラウザ描画・再読込の成功を保証しない |
| 今回のEumenes側作業 | 記録・利用説明・設計書・索引だけを更新。コード・設定・配備・サービス状態を変更せず、SSH接続・試験の再実行も行わない |

コード修正の担当は、解説preflightを扱うDocling backendと生成操作を扱うfrontend、warningsを扱うDocling frontend。配備・配信資産更新と実ブラウザ受入は後続の未着手段階で、今回の報告から操作の許可を推定しない。

### 報告された修正内容

- **解説**：認証未設定で診断が`not_configured`なのにoverviewの`configuration_error=null`となる不整合を再現。overviewでも診断と同じproviderのローカルpreflightを使い、設定不足の案内文を共通化した。画面は生成前に理由を表示し、自動生成・再試行・再生成POSTを抑止する。認証未設定でも保存済み解説の取得・閲覧・Markdown/JSON書き出しを維持し、事前確認で外部認証・生成APIを呼ばない。
- **warnings**：保存ファイル・APIに残っていたwarningsをfrontendのJob型へ追加し、応答形式の検査と共通文書ビューアーの表示を追加した。欠落・空・複数件、再取得後の表示、HTML風文字列の安全なテキスト表示を確認。汎用warningsはTeX固有の組版理由と別表示し、failedの既存error、原本・ソース閲覧を維持した。

failedの保存済みerrorと通信messageの併記、翻訳入口の未設定表示という任意の改善候補まで実装したとの報告は受けていない。通信間隔、自動停止、ocr-host adapterも今回の修正対象外であり、以前の設計合意待ち・追加開発の分類を維持する。

### 修正後の隔離試験と除外した実行

| 検証 | Docling側報告 |
| --- | --- |
| Python隔離fixture | 105件成功 |
| frontend fixture | 6ファイル・47件成功。jsdomとfixture応答による検証 |
| TypeScript型検査 | 成功 |
| 変更箇所のESLint・Ruff・書式検査 | 成功 |
| 解説の条件 | 認証設定あり/なし×保存済み解説あり/なしの4条件、認証なしのPOST抑止、保存済み解説閲覧、設定済みの通常生成・再生成をfixtureで確認 |

初回の予備試験では、既存fixtureからSQLite writer補助プロセスを起動してしまったとの報告があり、その実行は受入集計から除外した。最終試験は同一プロセス内の一時DBへ差し替え、通信・子プロセス・待受・アプリ起動を禁止するガード下で検証したとの報告。除外した実行を成功件数へ戻さず、最終の105件・47件と分けて扱う。

Docling側の検証記録は`/opt/docling-desk/qa/preflight-warnings-acceptance.md`との報告。このパスはDocling側の資料所在であり、この記録作業では直接閲覧していない。以前のWord/PDF閲覧・ログイン成功、隔離テスト42件、通信間隔11条件は、今回の修正後受入に含めていない。

### 後日の実ブラウザ受入へ進む条件

修正を含むbackendとfrontend配信資産を**同じ版**へ反映し、コード版・配備版・資産版の対応を記録することが前提。その段階で、上記再受入条件1・2の4条件、生成POSTの抑止と設定済みの通常生成・再生成、warningsの実ブラウザ再読込後表示、failed/error、原本・ソース・保存済み解説と書き出しを確認する。必要な操作を許可されるまでは、配備や実接続・ブラウザ試験を開始しない。

Docling側報告ではSSH接続、Docling・LARM・gateway・試験サーバーの起動停止操作を行っていない。入口28765、UI-ticketの60秒・一回限り・303、Cookie属性、frame保護、gateway管理、共通ライブラリの扱いも変更していない。Eumenes側コード、OCR adapter、通信間隔、自動停止は変更対象外。これらの制約と未変更範囲を維持し、配備済み・実接続受入済みとは宣言しない。
