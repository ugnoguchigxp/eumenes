# Excalidraw連携 作業記録

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
