# CPU計算ツールチェーンの検証

2026-10-21。目的はLARM CPUサービスを既存の登録・非同期実行・成果物表示へ接続すること。

仕様の修正と実装は利用者が明示許可。製品の設定変更とサーバー起動・停止・再起動は許可範囲に含めない。開始時からある `agent-runtime/service/execution-plan.ts` と `agent-runtime/test/task-execution.test.ts` の未コミット変更は担当外として保持する。

## 検証予定

- 部分: compute domainの受付・key/本文・状態・取消・再open復帰、LARM clientの広告/URL/認証/HTTP契約。
- 結合: compute adapterとHTTP取得、会話→日常担当→登録command→実行結果の採用、全bundle seed。
- 表示: DesignSystem、OpenUI JSON合成、Web adapterのsource更新と取得失敗。
- 全体: compute/larm/capabilities/tool-runtime/agent-runtime/dialogue/artifactのdomain指定verify。検証中は入力ファイルを編集しない。
- live/ブラウザ/実プロセス再起動: 未実施。DNS・設定整合と、必要なサーバー操作の許可が前提。

## 読み取り専用の実接続調査

保存済みControl `http://192.168.0.130:9810` のcatalogを既存Control Bearerで取得し200。ルート/profile別の広告に `http://gnosis.local:9810/v1/compute` がある。capabilityとprotocolは依頼仕様と一致。資格情報の値は出力・記録していない。

広告先は実行環境で `ENOTFOUND`。また保存済みControlと異originであるため、既存と同じ認証送信先の制約に適合しない。environment取得、計算投入、LLMの実選択は未確認。固定IPへの広告書換え・製品設定変更・サーバー操作は行っていない。

## 実行結果

部分31件、application結合6件、OpenUI合成1件、Web adapter2件、DesignSystem2件の計42件を用意した。最終版でも全件成功。

最初の6domain verifyは成功（Bun 1,007件、Web 24件、DesignSystem 2件、計1,033件）。型・境界・書式・lint・buildを含む。最終点検で親の停止確認と復旧後通知を補強したため、最終版でも再確認し成功した。

7domain（artifactを含む）verifyはサイズ検査で停止。`packages/artifact-ui/src/composition-fixer.ts` が827行、`ui-studio-components.tsx` が974行で、いずれも今回の差分なし。上限を緩和せず、担当外の改修もしない。

全bundleのfresh初期化試験には別件の既存失敗がある。`toolchain:task.execute@8` の `unavailable`。HEADの試験を使い新規compute bundleだけを除いた対照実行でも同じ失敗を確認した。計算bundle単体のcheck、再seed、通常サーバー組立てでのseedと公開版保持の試験は成功している。

新しいclientを使う読み取り専用runner `bun scripts/compute-live.ts --run` は `compute_origin_mismatch` で停止。保存済みControlと広告のorigin不一致を、広告先へ資格情報を送る前に拒否した。計算のPOSTは行っていない。

作業中にagent-runtimeの日常担当、関連fixture・文書の別件変更も増えた。これらへ意味上の変更は行わず、最終差分でも担当外として識別する。


## 最終結果と証拠

- 最終6domain verify: 成功、64,721 ms。Bun 1,007件、Web 24件、DesignSystem 2件、失敗0。inventory、境界、SystemContext、サイズ、書式、lint、型、DesignSystem buildを含む。
- runId: `2026-10-21T10-33-01-978Z-b8fd969a-64ff-473b-bff2-e8fd623fc651`。入力revision: `1c7f074b2fa9ff7869a5f9f4091c08ccd418128c46c139761aafce0f7ddc457f`。
- [最終verifyログ](../../../verification-reports/compute-cpu/backend-verify-final.log)、[機械可読report](../../../verification-reports/runs/2026-10-21T10-33-01-978Z-b8fd969a-64ff-473b-bff2-e8fd623fc651/report.json)。
- 最終application＋OpenUI結合: 7件成功、失敗0、45 assertions。[ログ](../../../verification-reports/compute-cpu/integration-final.log)。会話選択→Python tool→保存receipt→LARM client→保存結果→親→最終会話、共通UI台帳の取消と再送、PNG取得、SVG attachment、復旧後通知、取消202中の停止未確認を含む。
- bundle check: issueなし。通常の隔離seed、同一内容の再投入、再open時の公開版保持を確認。製品DBへの登録・公開切替は未実施。
- 全workspace型検査: 2,313ファイルで成功。追加・変更したapplicationのlint、最終 `git diff --check` も成功。
- liveは[読み取り専用discoveryログ](../../../verification-reports/compute-cpu/live-discovery.log)で `compute_origin_mismatch`。外部計算・実LLM・ブラウザ表示・実プロセス再起動は未実施。

## 登録と変更範囲

`compute_python` → `package:compute.python@1` → `binding:compute.command@1` → `adapter:compute@1` → compute domain / queue → LARM HTTP。表示は `artifact:compute.workspace@1` → OpenUI `compute-workspace` → DesignSystem `ComputeWorkspace`。

LLM向けは `tool:python_submit@1` / `tool:python_status@1` / `tool:python_cancel@1` / `tool:python_artifact@1`。登録adapter内部の操作名は既存契約に合わせて `compute.submit` / `compute.status` / `compute.cancel` / `compute.artifact`。引数は [利用手順](../../../docs/compute.md) に記載した。

主な製品変更はlarm client/契約、compute domain、applicationでの組立てとadapter登録、bundleと新規validator、認証済み成果物API、Web adapter、DesignSystem/OpenUIの登録部品。旧案はCPU仕様へ更新し、登録手順とdomain索引へ追記した。

専用部分の根拠は外部 `larm.compute.v1` の非同期HTTP・冪等性・取消・保持契約、および状態一覧と複数成果物を扱う表示要件。登録・queue・writer・親の結果採用・通知・Artifact hostは再利用した。発話の語句、計算題材、特定の数式による振分けや固定回答の製品コードは追加していない。正常・異常の固定入力は試験側だけに置いた。

## 進め方の見直し

- 静的確認の段階で表示部品の公開型と関数サイズを修正し、境界は維持した。部分30件の成功を根拠に結合へ進んだ。
- bundleの内部操作名が既存の命名契約に合わないことを確認し、adapter内部だけをdot形式に合わせた。既存validatorを弱めず、LLM向け4toolの名前も維持した。
- 全体検証の担当外失敗は同じ実行を繰り返さず、HEAD試験の対照実行と未変更ファイルの差分確認で分離した。6domainの再実行は親の停止確認・通知の接続を変更した後の最終確認として行った。

残作業はDNS/保存Controlと広告の整合、許可された環境での実計算・実LLM・ブラウザ・再起動受入。artifact全体の既存サイズ違反とtask.executeの既存seed試験失敗も別件として残る。製品設定やサーバーを変更せず、この範囲で作業を区切る。


## コードレビュー後の修正（2026-10-21）

利用者の依頼により今回のツールチェーン差分を再レビュー。サブエージェントや製品サーバー操作は使わず、実装した状態遷移・HTTP・adapter・表示・既存機構との接続を確認した。

次の8点は修正前の失敗を固定試験で再現し、修正後の成功を確認した。

1. 復旧が元の期限を延長し、期限切れの受理不明POSTも再送できた。元の期限を維持し、期限切れ・jobId未確定は拒否する。実送信直前にも期限・親権限を検査する。
2. 長いRetry-Afterで期限後の取消が遅れた。状態取得・成果物取得の再試行待ちを残り期限内に収める。
3. 10件のモデル向けsnapshotを権限リストにも使い、古いジョブの参照が拒否された。入力契約とdomainの所有者・会話検査を使い、表示件数から認可を判断しない。
4. DELETEが非同期受付を返した後、終端から削除へ進まなかった。明示的な削除要求を保持して完遂する。
5. DELETEの応答jobIdを検査していなかった。他jobの応答は取得・取消と同様に拒否する。
6. PNGプレビュー取得の失敗で結果画面全体が非表示になった。状態と結果を表示し、プレビューだけを省略する。
7. 一部成果物の失敗で取得成功した成果物も保存されなかった。成功分を保存し、不足分だけを再取得する。
8. 成果物取得中に親が失効した場合、完了通知とinvalidated更新が漏れた。確定時に元の期限と親権限を再検査する。

[修正前の回帰試験](../../../verification-reports/compute-cpu/review-before.log)、[HTTP・削除の修正前](../../../verification-reports/compute-cpu/review-round2-before.log)、[表示の修正前](../../../verification-reports/compute-cpu/review-web-before.log)、[部分成果物の修正前](../../../verification-reports/compute-cpu/review-round3-before.log)、[取得中失効の修正前](../../../verification-reports/compute-cpu/review-fetch-invalidation-before.log)。

部分・application・OpenUI合成の最終試験は45件成功、失敗0（134 assertions）。[最終試験ログ](../../../verification-reports/compute-cpu/review-final-tests.log)。Web adapterは3件成功。[表示試験ログ](../../../verification-reports/compute-cpu/review-web.log)。追加回帰試験は合計8件。再レビューで今回の範囲に追加の修正指摘なし。意味判断を代替する分岐・題材固有の処理・担当外の修正は追加していない。

3巡時点で進め方を見直し、各修正の再現と成功を根拠に継続し、最終差分点検と全体検証へ移った。実接続・実LLM・ブラウザ・実プロセス再起動の未確認条件は前記のとおり。

レビュー後の最終全体検証は成功（63,891 ms）。Bun 1,014件、Web 25件、DesignSystem 2件、計1,041件成功・失敗0。inventory・境界・SystemContext・サイズ・書式・lint・型・buildを含む。検証中の入力変更なし（integrityErrorsなし）。runIdは `2026-10-21T10-46-40-733Z-926af72a-bddb-4400-b9ac-5a168a29716d`、入力revisionは `455aeecdda313b26c8e1d6834aec9cd7d2f6677cacac60fafbba87fe3277d2b7`。

[6domain検証ログ](../../../verification-reports/compute-cpu/review-domain-verify.log)、[機械可読report](../../../verification-reports/runs/2026-10-21T10-46-40-733Z-926af72a-bddb-4400-b9ac-5a168a29716d/report.json)。application＋OpenUI結合も最終版で8件成功・失敗0（48 assertions）。[結合ログ](../../../verification-reports/compute-cpu/review-final-integration.log)。全workspace型検査は2,315ファイル成功。追加試験の配列を固定長tupleに直した後の再検証で、期待値の緩和はない。

bundle check、今回のapplication lintとサイズ検査も成功。全bundle初期化は別件の `toolchain:task.execute@9 unavailable` で1件失敗、公開版保持と通常サーバー組立ての2件は成功した（前回の同系統の失敗は@8）。[seedログ](../../../verification-reports/compute-cpu/review-seed.log)。未変更のOpenUI2ファイルのサイズ超過も継続しており、[サイズ検査ログ](../../../verification-reports/compute-cpu/review-artifact-size.log)に記録した。これらの担当外ファイルは修正していない。

## 履歴UIの変更（2026-10-21）

利用者指定: アーティファクトは画面幅50%を想定し、履歴サイドバーを設けず、ドロップダウンまたはタブで過去の計算へ切り替える。履歴件数が増えても横幅を消費しない上部ドロップダウンを選び、既存DesignSystemのSelectを再利用した。表示部品・Storybook・設計書・画像生成UI案v2を更新した。共通分割画面の既定50:50は変更していない。登録・接続可用性の仕様や製品設定は変更しない。

部分: 表示部品3件成功。過去の計算を選択後、状態更新でも選択を保持し、取消が選択したjobへ届くことを確認した。結合: OpenUIのJSON合成1件成功。全体: `bun run verify -- --domain compute` が11,190 msで成功。型・境界・SystemContext・サイズ・書式・lint・DesignSystem build・domain/Web/部品試験を含む。入力変更の検出なし。runId `2026-10-21T11-49-07-308Z-3f6533f6-a5b4-47f8-9e40-472466c14a12`。

[domain検証ログ](../../../verification-reports/compute-cpu/ui-history-verify.log)、[OpenUI合成ログ](../../../verification-reports/compute-cpu/ui-history-composition.log)、[UI案v2と反映範囲](../../assets/compute-ui-2026-10-21/README.md)。artifact全体の検証は前記の未変更ファイルのサイズ超過のため省略し、今回の表示合成を個別に確認した。サーバー起動・再起動と製品ブラウザでの表示確認は未実施。最終差分に意味判断の代替や題材固有の処理は追加していない。

## ライブラリタブの実装（2026-10-21、現行）

利用者がSelectを不可とし、画像生成ライブラリと同様の一覧を別タブに分ける方針を承認してアーティファクト実装を依頼した。直前のドロップダウンを撤去し、「計算結果」「ライブラリ」の既存Tabsへ置換。ライブラリは計算ID・状態・成果物件数・開く操作のテーブルで、開くと個別の結果タブへ移る。会話50%・アーティファクト50%とサイドバーなしを維持した。画像生成の一覧／個別表示の分離を再利用し、静的な既存DataTableへ操作可能セルを追加する拡張は行わない。

部分: 表示部品3件成功。ライブラリと結果の表示切替、更新後の選択保持、選択jobへの取消・ダウンロードを確認。全体: `bun run verify -- --domain compute` は12,837 msで成功。Bun22件・Web3件・表示部品3件、合計28件成功。型・境界・SystemContext・サイズ・書式・lint・DesignSystem buildも成功。入力変更検出なし。runId `2026-10-21T11-58-49-362Z-eab0fb75-3a5e-4dbb-825d-d4acf6a67b11`。[検証ログ](../../../verification-reports/compute-cpu/ui-library-verify.log)。

結合: application＋OpenUI8件成功（48 assertions）。[結合ログ](../../../verification-reports/compute-cpu/ui-library-integration.log)。画像生成UI案v3・設計書・利用手順・Storybookも現行方針に揃えた。artifact全体の未変更ファイルのサイズ超過は前記のとおりで、今回の合成を個別に検証した。製品サーバー・設定・接続可用性の条件は変更せず、製品ブラウザの表示確認は未実施。関連36件成功を製品受入済みとは扱わない。担当外の変更やLLMの判断を代替する処理は追加していない。

## メニューに「計算」がない不具合（2026-10-21、修正・実画面確認済み）

利用者の添付画面と既存Braveの実画面で、計算がメニューにないことを確認した。入口の不具合を残したまま、部品・固定試験の成功だけで「アーティファクトに実装しました」と報告したのは不十分だった。

確定原因は、共通Artifact解決がadapter.availableInTransactionを実行と表示に共用し、未接続・履歴0件のcomputeを一覧から除外していたこと。任意のartifactAvailableInTransactionを共通adapter契約に追加し、未実装adapterの従来動作を維持しつつ計算画面だけローカル表示を許可する。登録・所有者・source・action/schemaの検査と、新規計算の環境検査は維持する。計算名など個別IDで共通コードを分岐しない。修正設計は実装前に現行設計書の第9節へ記載した。

修正前の失敗を[回帰試験ログ](../../../verification-reports/compute-cpu/menu-before.log)に記録した。部分6件成功、application/OpenUI結合9件成功。未接続・履歴0件で一覧→表示定義→sourceが取得でき、新規計算は拒否される。共通adapterは指定なしで従来どおり閉じ、明示的な画面用falseも尊重する。

`bun run verify -- --domain compute --domain tool-runtime --domain capabilities` は21,530 msで成功。Bun144件・Web3件・部品3件、計150件成功。型・境界・SystemContext・サイズ・書式・lint・buildも成功。runId `2026-10-21T12-04-41-311Z-a3a1e334-bb09-4e23-8c11-007a02e14a0b`。[検証ログ](../../../verification-reports/compute-cpu/menu-domain-verify.log)、[結合ログ](../../../verification-reports/compute-cpu/menu-integration.log)。全workspace型検査2,315ファイルも成功。

稼働中APIの再確認ではHTTP200・computeVisible=false。修正したコードはまだ稼働プロセスへ未反映。AGENTS.mdの再起動許可規則に従い、修正と検証を揃えてから利用者へ開発サーバー再起動の許可を依頼した。製品のメニュー・ライブラリタブを確認するまで完了とはしない。

### 許可後の製品反映と実画面

利用者が「再起動して画面まで確認する」を明示的に許可したため、既存のEumenes開発サーバーを通常の終了手順で停止し、同じ `bun run dev` でAPI/Webを再起動した。設定変更と計算の投入は行っていない。2026-10-21 21:22 JST、server.listeningとVite readyを確認。bootId `f6ef5fd1-645c-4627-a1b2-caab985b9425`。

既存API認証で製品APIを確認: `GET /api/toolchain-artifacts` は200・computeVisible=true、計算の表示定義とsourceも200。sourceはenvironmentなし・保存ジョブ0件。資格情報と会話本文は出力・記録していない。

既存Braveの `http://127.0.0.1:5173/` を再読み込みし、実際のメニューに「計算」があることを確認してクリック。「計算結果」タブの空状態を確認後、「ライブラリ」タブへ切り替え、「計算履歴 0件」と計算・状態・成果物・操作の表を確認した。分割幅aria-valuenowは50、ライブラリaria-selectedはtrue、テーブルvisibleはtrue。Selectと履歴サイドバーなし。ブラウザは計算ライブラリを表示したままにした。

実画面の証拠: [メニュー](../../../verification-reports/compute-cpu/menu-live.jpg)、[計算結果](../../../verification-reports/compute-cpu/result-live.jpg)、[ライブラリ](../../../verification-reports/compute-cpu/library-live.jpg)。画像生成案ではなく製品ブラウザのスクリーンショット。会話本文を含めず対象画面だけを記録した。

今回のメニュー非表示の修正と空状態の製品表示確認は完了。計算サービスの環境取得・実計算・成果物実体のlive確認は未完了のままであり、入口を表示できたことを計算実行成功として扱わない。既存の別Web bundleのrevision_conflictは再起動時にも観測したが、今回の変更対象にしない。


## 実CPU計算と実LLMの確認（2026-10-21）

利用者の「実際計算させてください」に基づき実行した。保存済みControlのcatalogを再確認すると、絶対urlに加えて `endpoint: /v1/compute` が広告されていた。同じControlへ解決したenvironmentが200であることを確認し、clientを広告endpointの契約へ接続した。絶対urlと相対endpointのパス一致、別origin・userinfo・query/hash・scheme-relativeの拒否を検査し、保存設定・DNS・資格情報の送信先を変更していない。変更設計は実装前に正本へ記載した。

部分・結合30件成功。`bun run verify -- --domain larm --domain compute` は13,634 msで成功（Bun274件、Web3件、表示部品3件、計280件）。runId `2026-10-21T12-28-41-131Z-46a2440a-5c01-47b4-bd1d-5871ac00b3c7`。[固定試験](../../../verification-reports/compute-cpu/endpoint-fixed.log)、[domain検証](../../../verification-reports/compute-cpu/endpoint-domain-verify.log)、[実発見・環境取得](../../../verification-reports/compute-cpu/endpoint-live-discovery.log)。利用者が許可した開発サーバー再起動で反映した。SIGINTによる終了時に二重signalの強制終了ログが出たが、その時点に実計算はなく、次回の起動完了後に投入した。

製品API→永続queue→LARM→成果物保存→製品API取得でjob `99a2c2b6-939e-475e-99cb-5a9fb3ac4c73` がcompleted。NumPyの1〜100の総和5050、SymPyのsin(x)の不定積分 `-cos(x)`、SciPyの二次関数の最小位置3を独立に検算した。PNG28,617bytesを800×400としてdecode、CSV5,059bytesの100行すべてがsin(x)と許容差1e-10以内で一致した。実ブラウザも画像のnaturalWidth800/naturalHeight400とライブラリの保存行を確認した。同一requestの重複投入を防ぐため、試験runnerは投入前にidempotency keyを保存し、再実行を拒否する。

[実計算結果](../../../verification-reports/compute-cpu/product-live-result.json)、[成果物検算](../../../verification-reports/compute-cpu/product-artifact-validation.json)、[変更前レイアウトの実結果画面](../../../verification-reports/compute-cpu/computed-result-live.jpg)。

実会話へ1+1を依頼したrun `8f071173-1a0b-47ec-9626-87659f206d3c` は、LLMがcompute.pythonを選択し `result = 1 + 1` を生成。job `1be826c0-4e4e-435b-adde-7f2e78f48558` はcompleted、値2。会話へ「計算結果: 2」の完了通知も保存された。ただし親会話の最終文生成・修復は `invalid_conversation_operation / control_text_in_body` で失敗し、会話run自体はfailed。計算機能の成功と最終会話の失敗を分け、担当外のdialogueコードは修正していない。[実LLM結果](../../../verification-reports/compute-cpu/llm-live-result.json)。

未実施: inputs付きlive計算、進行中の実取消→次job成功、実job処理中のプロセス再起動、live同key conflict。固定試験での確認をlive受入へ読み替えない。

## コード・結果のアコーディオン（2026-10-21）

利用者の指定により「実行したPythonコード」（初期状態で閉じる）→「結果」（開く）の順へ変更した。既存Collapsibleを再利用し、結果値・標準出力・標準エラー・計算エラー・成果物取得エラー・グラフ・ダウンロードを結果の内側に配置。更新後も開閉を保持し、別jobを開くと初期状態へ戻す。状態・取消操作とライブラリタブは維持した。題材固有の判断・計算ロジックは表示部品へ加えていない。

部分4件・application/OpenUI結合9件成功。初回の型検査で試験用role検索の未対応optionを検出し、同じ完全一致条件の正規表現へ修正した。再検証 `bun run verify -- --domain compute` は11,547 msで成功（Bun22件、Web3件、部品4件、計29件）。型・境界・SystemContext・サイズ・書式・lint・DesignSystem buildを含む。runId `2026-10-21T12-39-55-902Z-0034258c-fb29-457e-8efa-beaebed34468`。検証中の入力変更なし。[部分試験](../../../verification-reports/compute-cpu/accordion-component.log)、[結合試験](../../../verification-reports/compute-cpu/accordion-integration.log)、[domain検証](../../../verification-reports/compute-cpu/accordion-domain-verify.log)。artifact全体は前記の担当外サイズ超過のため繰り返さず、今回の合成を個別に確認した。


製品画面はViteのwatch/HMR無効設定のため、reloadのみでは旧表示だった。利用者の再起動許可に基づきmanagerへSIGTERMを送り、shutdown_completedを確認してから起動。2026-10-21 21:42 JST、bootId `cd56fab6-5612-427d-a8c6-c740c249f8db` で反映した。計算を再投入せず、ライブラリの保存済み2件から実グラフのjobを開き、コードclosed→結果openの順、結果を閉じるとグラフとダウンロードが非表示、コードを開くと実行済みコードが見えることを確認した。最後はコードclosed・結果openに戻している。[現行の実結果画面](../../../verification-reports/compute-cpu/accordion-result-live.jpg)、[実計算2件のライブラリ](../../../verification-reports/compute-cpu/computed-library-live.jpg)。

最終差分点検: 今回のclient変更は広告された接続契約の検査と外部IO、表示変更は既存Collapsibleの組合せに限定。語句・題材に応じた意味判断や自動再投入は追加していない。同時に存在するagent-runtime/dialogue/task-execution等の担当外変更は保持し、追加修正していない。git diff --check成功。


## 状態表示を1行へ整理（2026-10-21）

利用者指定により、個別結果の「計算 ID」見出し・状態テキスト・生stageの3行を、既存Badgeと短縮IDの横1行へ変更。完全なIDはtitleとアクセシブル名に保持し、取消中・進捗・取消操作は残す。見出しを除いた分、アコーディオンの見出し階層をh3へ揃えた。設計と利用手順も更新した。

表示部品4件、application/OpenUI結合9件成功。compute domain検証は14,498msで成功（Bun22・Web3・部品4、計29件、型・境界・SystemContext・サイズ・書式・lint・buildを含む）。runId `2026-10-21T13-16-47-818Z-3c2e4b42-41de-41e4-b47a-3c7f299954ef`。[部品](../../../verification-reports/compute-cpu/status-row-component.log)、[結合](../../../verification-reports/compute-cpu/status-row-integration.log)、[domain検証](../../../verification-reports/compute-cpu/status-row-verify.log)。

既存の再起動許可に基づき反映。実画面の保存済みjob `1be826c0` で、状態行が高さ31px、バッジとIDが同じ行に収まり、生のcompletedと独立見出しがないことを確認。[実画面](../../../verification-reports/compute-cpu/status-row-live.jpg)。他のdomainの同時進行差分には追加編集せず、計算・意味判断の処理は変更していない。git diff --check成功。
