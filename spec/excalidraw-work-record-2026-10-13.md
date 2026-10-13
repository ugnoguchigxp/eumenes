# Excalidraw連携 作業記録

## 並行差分を含むmainの全体受入

2026年10月14日、利用者がsettings→memory依存違反の修正と、並行差分を反映したmainでの全体検証・正式接続通し確認を依頼した。今回の検証対象は古いmainの固定版ではなく、現在のmainの作業ツリーとする。最初のinitial_instructionsは再実行しない。

修正方針: MemoryItemsPanelの試験型を既存の公開client/画面props契約から導出し、memory domainの直接参照と試験依存の例外宣言を除去する。発話判断・LLM選択・UI業務判断・検証期待値は変更しない。共有client契約が並行差分で公開されていることを再確認し、必要な統合修正は原因を特定してから行う。

依存順と完了条件: settingsの部分gate → Excalidraw/API/共有clientの結合 → 影響のあるdomainのverifyと必要なbuild → 現在のmainから起動したbackend/Webで正式cold起動、編集保存再表示、自然停止と再接続、backend再起動復帰、実LLM/Artifactの通し確認 → 差分点検と証拠保存。各段階で入力変更を検知した結果は合格としない。正常な長時間停止待ちは中断しない。三ラウンドまたは停滞時には根拠と計画を見直す。Linux配備・credential・製品DBのコピーは行わない。

## mainでの最終受入再開

利用者が実装と検証の完遂を依頼したため中断を解除する。initial_instructionsは開始時の一回を維持。既存の担当定義・公開drawing_editorツール・暗号化設定・scene保存・Artifactの接続を再利用する。新しいブランチは作らない。

残作業と依存順: 部分domain gate → settings/client/application結合とブラウザfixture → 利用側・verify:all/build → 正式接続のcold起動、編集保存再表示、自然停止、再接続ボタンからの追加編集保存再表示 → backend再起動復帰 → 実LLMの担当選択と会話・Artifact・URL確認 → 差分点検と結果整理。正式接続試験に再接続ボタンと追加保存版4/形状2の確認を追加する。待機上限や正式idle設定は緩めない。

完了条件: 各結果を固定/正式接続/MacBook実画面で分け、保存版・形状とworker PIDの停止/変更、backend再起動後の保持、実LLM runと採用operationを記録する。失敗はwarnログと相関IDから調査し、原因が確定した担当範囲だけを修正する。Linux配備・consumer登録、既存memory境界違反は調査のみ。根拠なしの同じ失敗は繰り返さない。

目的: Eumenesの認証済みブラウザ入口から図の編集、scene APIによる保存、図IDと版からの再表示、無操作lease解放と再接続を提供する。

範囲: Excalidraw domain、LARM Local Servicesアダプター、backend設定、会話ツールチェーン、DesignSystem/OpenUI、Web/client、固定試験と実接続確認。Linux製品の配備・consumer登録・製品DB変更は担当外。既存の未コミット変更は保持する。

依存順: 上流仕様/配備の確認 → 設定/lease接続 → scene/参照保存API → 担当登録/実行 → OpenUI/編集画面 → 部分/結合/全体 → live/MacBook。

再利用: LLMによるツールチェーン選択、capabilitiesのpackage/Skill/SystemContext、queueの実行と結果採用、settingsの暗号化、API認証/Origin検査、OpenUIのJSON/source。発話による固定振り分けは追加しない。

専用部分の根拠: 上流画面はroot相対fetchと接続キー入力を前提とする。prefix proxyでは認証・asset・保存を解決できないため、上流と同版のExcalidraw部品をEumenesのWeb入口で使用し、認証済みbackend APIからsceneを保存する。上流の図が正本。portをidentityにしない。LARM clientは本repoの依存に無いため、公開lease契約の必要部分を型付きadapterとして接続する。

完了条件: cold/starting/ready/失敗、binding照合、API認証、図作成/編集/保存/再表示、下書き保護、無操作解放、再起動復帰、会話→Artifact、各domainとverify:all、fixture/live/実機の区別を記録。

初期確認: 指定Page読取済み。保存済みLARM接続をsettingsの読取操作で確認。gnosisにexcalidraw-hostソースあり。excalidraw-host.service、larm-local-service-excalidraw.service、larm-hosted-excalidraw.serviceはnot-found。Eumenesの既存設定に専用consumer/app tokenの登録機構はない。

実装済み: 専用consumer/app credentialの暗号化設定、起動とbinding照合、Eumenes Web originの版付きURL、scene保存・参照保持、LLM担当のplan/open二段階、OpenUIのdrawing-workspace、編集画面、下書き・保存候補と追加編集の保護、idle解放、閉じる/pagehideの自分のlease解放、backend再起動後の復帰。

追加した接続条件: gatewayUrlとgatewayOriginを分け、Mac側の中継ポートと元のgatewayが違う場合もHostを合わせる。leaseEndpointは独立したworker bindingとして照合する。実HTTPで検証した。上流へOrigin/Cookieは転送しない。

修正・再確認: 保存JSONから省かれるfilesを明示保持。図ID/版の切替時に旧編集状態を再利用せず、遅い読込みで入力を上書きしない。失敗した保存候補と、その後の変更の両方を保護する。古い版の再表示・古い保存の再確認で最新版の参照名を戻さない。ブラウザ保存先が満杯なら下書きを保持できたと表示しない。会話から連続して図を開く際も新しい完了結果へ切替え、idle後も保存済みEumenes URLから復帰できる。

検証済み（fixture）: backend/設定32試験、最終excalidraw domain（backend 5試験とWeb 3試験）、application結合4試験、dialogue 209試験とWeb 6試験、larm/capabilities/artifact domain検証、全体型検査、DesignSystem/Web build。MacBook上のheadless Chromium通し試験は新規起動→URL表示→描画→版2/3保存→再表示→保存失敗→再読込み/下書き復元→版4保存→無操作解放→再起動復帰/版5保存→会話から2回連続起動を合格した。実サービスの停止を観測したという意味ではない。

失敗と対応: UI試験でfiles欠落、版切替時の状態再利用を再現し修正した。ブラウザ試験中のDesignSystemビルドによる画面再読込みは無効な検証として扱い、ビルド終了後に単独実行して合格を確認した。試験期待値は緩めていない。

全体gateの未完了: settings domainとverify:allは、担当外のweb/src/domains/settings/MemoryItemsPanel.test.tsx:12がmemory domainの契約を直接参照する境界違反で停止した。境界宣言・試験の期待値を変えて通す処理は行っていない。settingsのBun試験は別途成功。全体gateの後続手順は未実行であり、全体合格とは報告しない。

正式配備/live: settingsの読取操作による接続確認とMacBookからのLARM Local Services入口確認のみ実施（503）。専用設定は製品DBへ未登録。gnosisのLocal Servicesは無効、consumer設定ファイルなし、Excalidraw systemd unitなし、正式18790入口のlistenなし。lease要求、正式scene編集・保存、実サービスのidle停止受入、実LLMによる新経路のlive受入は未実施。製品DB・設定・秘密をコピーせず、Linux配備とconsumer登録も変更していない。

差分点検: 言い回し・題材・個別発話の条件分岐は追加していない。専用部分は外部lease/scene契約、認証とHost/Origin/bindingの強制、操作状態と保存参照に限定。既存および並行作業のimage/object-recognition/設定等の変更がある共有ファイルには必要な配線を追記した。担当外のmemoryテストは修正していない。

残条件: 正式Linux配備、excalidraw-hostを利用可能なEumenes専用consumerと業務credential、Mac backendから到達するgateway経路と正しいgatewayOrigin/leaseEndpointの設定後にlive受入を実施する。全体gateは既存のsettings→memory境界違反の解消後に再実行する。

証拠: spec/verification/excalidraw-2026-10-13/。使用手順・APIはdocs/excalidraw.md。

MCP: initial_instructions 1回、context_compile 1回、compile_eval 1回（runId: 00000000-0000-0000-18de-05293fe30240）。

## Eumenes側の追加整備（検証延期）

最新の利用者指示: Linuxの正式配備・専用consumer登録はLARMへ依頼済み。こちらはEumenes側の実装を進め、検証は後で実施する。管理者操作の依頼、Linux設定変更、実接続検証は今回行わない。

範囲と順序: 別会話の図の再表示契約 → 編集画面の履歴復帰と下書き保護 → 正式接続情報の受入スクリプト → 回帰試験と受入手順の準備 → 差分点検。既存LLMルーティング、図参照の会話境界、API認証と暗号化設定を再利用する。担当外の会話画像等の差分は保持する。

根拠: 編集URLは会話IDを持たず、編集画面のPOSTはmainを既定とするため、main以外の図を会話所有境界の検査で開けない。pagehideでsessionをclosedにする一方、ブラウザ履歴から画面が復元される場合のsession再作成がない。sessionStorageへの初回アクセスが失敗すると編集画面自体が描画できない。上流保存成功後の下書き削除例外を保存APIの失敗と同じcatchで扱っている。

完了条件: 上記の処理を実装し、後で行う回帰試験を追加、配備依存と延期した検証を記録する。検証済みとは報告しない。

実装追加: main以外の会話をURLと編集sessionの作成へ渡し、backendの会話境界を維持。ブラウザ履歴復帰時のsession再作成、編集内容の保持、再接続取消時の遅いsession解放を接続。下書きストレージへのアクセスを遅延して例外を扱い、上流保存成功と下書き削除失敗を分離。編集ライフサイクル・下書き保護・session補助を分け、既存の保存契約と状態は維持した。

接続準備: 接続入力schemaをsettingsのcontractsへ移し、clientの公開設定操作を追加。LARM側と合意した接続情報を受け取るスクリプトは、専用のprivate JSONから入力確認または既存設定API経由の保存だけを行う。SSH固定hand-off依存と暫定Linux登録スクリプトはローカル実装から撤去。前回Linuxへ置いた未実行の暫定スクリプトを正式手順として使わない。

正式配備の観測更新: 2026年10月13日22:28 JSTではLocal Servicesが有効、gateway unitがactive/enabled、worker unitが登録済み/inactive。稼働consumer一覧はeumenes-hosted-appsとgateway用consumerを含む。専用Eumenes consumerとEumenes暗号化設定への登録は未実行。gateway180秒/worker120秒の現行値との差はLARMへの依頼事項。初回の「未配備」は当時の観測で、現在の状態ではない。

回帰試験の準備: 非main会話の版付き再表示・既存の所有境界、URL入力不正、保存領域拒否、削除だけの失敗、履歴復帰と未保存内容、取消後の遅いsession解放を追加。正式接続ブラウザ試験は明示有効化時だけ実行し、scene再取得とsystemd workerの実停止・次回起動を別の証拠にする。

今回の検証状態: 利用者の指定でテスト、lint、型検査、build、fixture/liveブラウザ試験は未実行。書式整備と差分の読取り点検のみ実施。以前の試験結果は以前の実装に対する結果で、今回の差分には適用しない。会話画像等の担当外変更は保持し、発話による専用分岐やLLM判断の代替は追加していない。

次回残作業: docs/excalidraw.mdの部分→結合→全体→正式接続の順で実施する。LARM側の完了報告と経路・資格情報の安全な引渡しを受けてから製品設定を保存し、MacBookでの実編集・保存・再表示、停止と復帰、backend再起動、実LLMを確認する。

今回のContextStill: context_compile 1回、compile_eval 1回（runId: 00000000-0000-0000-18de-1a40f6af45fe）。initial_instructionsは開始時の1回を再利用し、再実行しない。

## 正式接続受入の再開

利用者がLARM側の準備完了を連絡し、接続確認・MacBookブラウザ編集保存再表示・無操作停止・再起動復帰を依頼。既存の専用consumer登録と分離credentialを使用する。Linux配備やsudo登録は変更しない。初期観測ではEumenes専用設定は未登録、正式gatewayはactive、consumer `eumenes-excalidraw`を確認。正式gateway180秒/worker120秒は現在Pageの仕様であり、30秒/60秒へ勝手に短縮しない。

依存順: 延期した部分試験 → 結合 → 接続設定保存・到達確認 → MacBookでcold起動と編集保存再表示 → 正式の無操作実停止と次回復帰 → Eumenes backend再起動と同じ図の保存 → 全体gate/差分点検/証拠保存。完了条件は実sceneの保存版と形状を再取得し、worker PIDの停止・変更とbackend再起動を観測すること。

初回domain検証は復帰hookのReact refs/immutability違反で停止。refの更新を所有hookへ戻し、利用側からは更新callbackとsignal取得操作を呼ぶ形に修正する。未検証の差分に対する失敗であり、以前の合格結果を適用しない。

## mainマージ時の到達点と残作業

利用者は検証を中断し、タスク未完了の状態でも現在のブランチをmainへマージするよう依頼した。機能の検証完了は宣言せず、再接続の修正と回帰試験を含めて保存する。ブラウザを起動する検証は再開しない。

正式接続の実施結果: LARM側が `eumenes-excalidraw` consumerを登録し、許可サービスがexcalidraw-hostだけであることを確認した。LARM側が用意した専用consumer/API資格情報をメモリ内で受け取り、既存の認証済みsettings APIへ暗号化保存した（設定revision 1）。資格情報はチャット・モデル・URL・Gitへ出していない。MacBookの127.0.0.1:18790からLinuxの正式gatewayへ接続するSSH経路を用意した。Linux配備やsudo登録は変更していない。

MacBookでの実操作: cold起動、Chromiumでの描画・版3保存・再表示、自然停止後の同じ図の復帰を確認した。worker PIDは2077267から2087020へ変わった。停止待ち中に追加の編集session起動が入り、自動ブラウザ試験は360秒の待機上限で失敗した。その後、最後の追加起動要求（2026-10-13T14:02:34.921Z）から約308秒後の自然停止（14:07:43.400Z）をLARMのsystemd状態とイベントで観測した。強制停止やidle設定の短縮は行っていない。

Eumenes再起動と保存: backendを再起動して暗号化接続設定と図参照の保持を確認した。開いていたブラウザで編集内容は版6まで保存されたが、固定の版5を待つ補助スクリプトは不一致で失敗した。この補助スクリプトは合格として扱わない。MacBookのBraveで同じ図を再表示し、名前の編集・版7保存・再読込み、矩形の追加・版8保存・再読込みを実操作で確認した。保存した図の参照IDは5ed3ee5b-ad09-4c10-8d9d-a99d13e94ff0。受入用の図は上流scene APIに保持される。

中断前に見つけた不具合と修正: 無操作解放後の再接続ボタン操作が、グローバルなpointerdownのactivity通知と競合した。再接続時にMap上の同じsession IDへ新しい接続が入っても、古い失敗処理が新しいleaseまで解放する問題があった。activity通知をExcalidraw内の実操作に限定し、失敗時は捕捉した古い接続だけを解放するよう修正した。発話の意味判定や個別依頼の専用分岐は追加していない。

修正後の固定検証: Excalidraw domain（backend 7試験・Web 9試験）、backend/settings/application結合34試験、全体型検査、保存失敗・下書き復元・無操作解放・再接続を含むブラウザfixtureを合格した。LARM 146試験、capabilities 24試験、artifact Web 49試験も実施した。Web buildは成功した。実サービスの最終再接続確認は利用者の再起動・中断依頼で未完了。実LLMによる会話からの起動の受入も未完了。

全体検証: verify:allは既存のweb/src/domains/settings/MemoryItemsPanel.test.tsxにあるsettings→memoryの依存違反で停止した。今回追加したclientの非公開contracts参照違反は公開contracts経由へ修正済み。既存のmemory境界違反を勝手に修正したり、期待値を緩めたりしていない。

再開条件: 実接続で修正後の「無操作解放→再接続→追加編集→保存→再表示」を最終確認し、独立した通し試験と実LLM経路を確認する。全体gateは既存境界違反の解消後に実施する。現在のmainマージはこの残作業を受け入れたcheckpointであり、機能全体の検証完了を意味しない。

Brave自動起動: 別のchrome-devtools-mcp起動ラッパーが接続時に専用Braveを自動起動していた。ラッパーを既存ブラウザの確認だけに変更し、接続プロセスを停止。2回の起動確認でBraveを開かないことを確認した。この修正はEumenesリポジトリの外にあり、今回のmainマージには含まれない。

## 2026年10月14日の受入結果

変更: Excalidraw製品コードへの追加は不要だった。mainへ入れた再接続競合の修正を実接続で確認した。正式接続のブラウザ試験を、reloadによる復帰だけでなく再接続ボタン、追加編集、版4/形状2の再取得まで拡張した。矩形ツールは同梱の日本語定義と実画面で名称「矩形」を確認し、操作待ちに20秒の上限を設定した。正式idle値、停止待ち360秒、保存版・形状の期待値は緩めていない。

固定検証: Excalidraw domainはbackend 7/Web 9、settings/application結合27、client Vitest 336、capabilities 24、LARM 146、Artifact Web 49、ブラウザfixture 1を合格。型検査とWeb buildは成功（既存の大きなchunk警告あり）。更新後の作業ツリーでもExcalidraw domainとapplication結合4を再確認して合格した。clientを誤ってBunで実行した試行はrunnerの不一致による失敗であり、正しいVitestの結果と区別する。verifyコマンドを並列起動した際のロック拒否も試験失敗と混同せず、settings gateは順番に再実行した。

全体gate: settings domainとverify:allはweb/src/domains/settings/MemoryItemsPanel.test.tsxのsettings→memory依存違反で停止。期待値・依存規則を弱めず、担当外として修正していない。並行作業のclient/toolchain-actions.tsがdialogue/contractsから存在しないinteractionAnswerをimportしているため、作業ツリーのclient読み込みも失敗した。この共有契約の改修は本タスクへ取り込んでいない。

俯瞰評価と方針変更: 最初の正式試験では共有ファイル更新によるHMRと、こちらが追加した英語ツール名の誤りを検出。次の試行も要素名を確定する前に始めたため中断した。再試行前に進め方を評価し、同梱localeと実画面の名称を根拠に修正し、mainのソースとworkspaceパッケージを固定した検証へ切り替えた。ブランチは作らずgit archiveの0cacd23から検証用ソースだけを用意し、製品DB・設定・credentialはコピーせず、backendが既存の保存先と暗号化設定を使用した。固定ソース1510ファイルは検証前後で変更なし。三つ目の自動試験ではcold起動・版3保存再表示・無操作解放・worker実停止まで確認したが、再接続操作の直前にブラウザが閉じられて失敗。終了原因は未確定。同じ自動試験は繰り返さず、MacBookの既存Braveでの実操作へ方針変更した。自動試験の完走は宣言しない。

実LLM: 非main会話のrun add3e339-e56c-4acd-a370-08fd877737bbとmain会話のrun 80ce13e5-2e79-4910-8d11-6223c3c11aedで、excalidraw.edit@1の選択、plan/openジョブ、completed操作、回答のブラウザURLを確認した。非main操作の確認スクリプトが既定mainの一覧を見て失敗した際は、再生成せず作成元conversationId付きの公開APIで同じ操作を確認した。mainの実画面では会話回答のURL、Artifactの保存済み図一覧、準備中→利用可能、Excalidrawを開くリンクから編集画面への移動まで確認。図を描いた・保存したことを発話の専用処理で補っていない。

MacBook実画面: 非mainの図参照c20b6255-38da-4851-a76f-ac2ca964d22fをBraveで開き、矩形1個を版2で保存・再読込みした。backend PID 74677を正常終了して78215で再起動し、版2のsceneのハッシュと設定revision 1が保持されたことをAPIと画面で確認。さらに矩形を追加し版3/2個を保存・再表示した。クリック位置がtoolbarに入った操作は描画成功と扱わず、画面上のcanvasへ描いて保存結果を確認した。

自然停止と最終復帰: 表示したまま無操作解放を確認し、SSHの読み取り専用systemd観測で2026-10-13T21:49:30.839Zにworker PID 2279353→0を記録した（systemd停止イベントは21:49:29Z）。最後のscene確認から約311秒で、gateway180秒/worker120秒を短縮せず停止した。Braveの再接続ボタンでworker PID 2286656へ起動し、版3が復帰。矩形を追加し版4/3個で保存、同じURLからの再表示とscene APIの再取得を合格した。取消後の古いleaseが新しいleaseを解放する競合は、この実接続操作では再発しなかった。

証拠: spec/verification/excalidraw-live/native-acceptance-2026-10-14.jsonに図の版・形状・ハッシュ、設定の公開情報、worker停止時系列とbackend再起動を記録。real-llm-2026-10-14.jsonとreal-llm-main-2026-10-14.jsonに今回の合成依頼、run、採用操作、回答を記録。source-stability-2026-10-14.jsonは固定ソースの確認結果。credentialやProvider生応答は保存していない。本人の別ブラウザタブ・会話履歴を含むnativeスクリーンショットはGitへ追加しない。

到達点と残作業: Excalidraw要求の実接続・MacBook操作・実LLM/Artifactの受入は確認済み。全体gateと並行改修を含む作業ツリー全体の受入は未完了。続行条件は既存memory境界違反と共有client契約の担当側での整合後に、現在の作業ツリーで全体gateとWeb通し確認を実施すること。本タスクの差分は試験・文書・検証証拠だけで、発話の意味判断の代替や担当外の修正は追加していない。

今回のContextStill: context_compile 1回、compile_eval 1回（runId: 00000000-0000-0000-18de-1debfb717569）。initial_instructionsは開始時の1回を再利用した。
