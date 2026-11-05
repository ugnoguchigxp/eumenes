# ブラウザ部品の本体統合

2026-11-05。利用者がeumenes_interact/docs/integration-design.mdに沿う本体実装を承認。単体main dc727e7、実装の受入対象5bdef97、正式技術81.9点を前提とする。mainで作業し、製品DBと稼働サーバーは変更しない。CIは対象外。

## 目的・接続・完了条件

検証用の既存会話/Artifact入口から、元依頼→browser domainの受付→既存Queue→保存設定の推論control/receipt→公開parts→専用の隔離browser→質問/承認/取消→保存正本の状態と撮影を返す。通常会話候補はavailability:browser.interact@1を初期無効にして残す。新しいexecution種別や独立DB・常駐推論ループは追加しない。

- package root/parts/sqliteと固定した実tgzを使用し、labのホストをコピーしない。
- browser domainにrunの対応情報・世代・質問/回答・期限・job参照・撮影の公開操作を配置。状態の正本はinteract_runs、操作は同packageの送出台帳。
- 既存browserのDriver/MCP transport、操作の承認判定と承認台帳、URL規則、CaptureFiles/encoderを再利用する。新engineは既存の利用者browser接続と異なる隔離driverを使用する。
- applicationは既存captureUserControl/executeControl/acceptInTransactionを接続し、設定とcatalogを正本にする。モデル名・キー・labのprovider設定を本体へ移さない。
- 新しい部品のPartExecutionPortが必要なのは、部品が要求する観測・操作・読取・撮影を本体のwriter・承認・世代へ戻す外部契約のため。意味判断はcoreへ与えるLLMの構造化出力で行う。
- 検証用の登録adapterは既存DomainAdapter.executionの開始/状態/回答/取消とreceiptを使う。Artifactは既存OpenUI部品のJSON構成と認証済みsource/actionを使う。

## 依存順と残作業

1. [x] 実tgzの固定、全file/Skill/migration照合とmigration先頭依存。
2. [x] domainの同時受付・owner/conversation・generation/revision・期限・質問/承認・取消・送出前commit・再起動/忘却・保持を実装。
3. [x] applicationの既存推論/Queue/receiptと専用隔離driverを接続。
4. [x] 新revisionのbundle、検証用入口、sourceと既存OpenUI表示を接続。通常候補は無効。
5. [x] 部分→結合→対象domain verify→隔離試験用サーバーとUI E2Eを実施。固定モデル/APIの結果とliveを分ける。

同じ目的の3ラウンドごとに進捗と仮説を見直す。検証中は入力の製品コードを編集しない。単体baselineは既存browserの285試験成功、0失敗、2257assertions（/tmp/eumenes-interact-baseline.log）。

## 保持・制限

原依頼・ページ本文・入力値を通常の操作履歴へ複写しない。実行文脈と未回答の表示本文はメモリのみで扱い、再起動時は未知の送出を隔離して自動再送しない。run/操作メタデータ30日、明示的な撮影7日。元依頼の撤回・忘却は新runと撮影・承認へ伝える。

有料のClaude/Luna検証を追加する場合は、単体repoの同じ10USD台帳（既存8.024065USDの保守的計上）を継続する。限界を超える検証や、通常会話向けの有効化はしない。今回の基本受入は固定応答とsynthetic fixtureで実施し、実LLMを使った範囲は別記する。

## 共同作業との差分の扱い

実装開始後にpipeline・協働・memory等の担当外の未コミット差分が同じ作業木で進行していることを確認した。他チャットへの送信は行わず、担当外を修正しない。今回のbrowser接続に必要な差分を限定し、検証はHEADと今回の変更を固定コピーへ取り出して行う。共有ファイルは既存の他変更を保持して追記し、一括stage/commitをしない。全体型検査の担当外エラーは隔離した元版との比較で区別する。

## 実装上の具体化

配布版0.1.1（source d459f1b）に、ホストが既存のWebP保存を使うためのmediaTypeと、公開forgetRunを追加した。配布manifest自体のhash、全134file、Skillを起動時に検査する。移植した実行機構はなく、root/parts/sqliteを使う。

本体の意味判断と完了照合は保存設定のmodel/controlを使う。完了照合は新しい文脈で1回行い、実行と合わせて最大10回。labのClaude/Lunaの組合せを製品へ固定しない。同じモデルを使う場合の相関した誤りは残るため、独立した実API受入の代用とはしない。

- 入力用フォームは既存Form、一覧/状態はwork-menu/work-result、撮影はgenerated-imageで構成する。確認の選択はquestion/runのidentityが変わると消し、別対象への承認の持越しを防ぐ。親実行が所有する作業の回答・取消・忘却は元の会話の機構を使う。
- サイト知識は上流に存在する4ファイル、10object/10candidateを出所commit/hash付きで取り込む。確認日は不明として記録し、現在のsnapshotで一意に一致する対応済みlocatorだけを使う。import時刻をlive確認日やverifiedへ変えない。
- 隔離ブラウザはmemory-only profile、download/service worker/QUIC等の抑止を使う。移動先には既存URL/DNS規則を適用する。ブラウザの全サブリソースをDNS固定proxyで隔離する機能は今回追加していない。通常会話での有効化・旧経路の置換は行わない。
- 通常実行の原依頼・本文・入力値はdomain/Queue履歴へ複写せず、終端後は一時文脈を消す。再起動時はcontext_lostまたはindeterminateに確定し、不明な送出を再実行しない。

最終検証はbase HEADと今回の変更のみから作った固定コピーで行う。検証のために製品DB・稼働中のサーバーを変更しない。


## 受入結果（2026-11-06）

検証用入口までの取り込みを完了。新規38件と、既存を含む広域/最終verifyが成功した。実HTTP・隔離Chromeで、質問への回答、撮影承認、読取、撮影、認証付きWebP取得、古い回答の拒否、忘却、同一忘却要求の再送まで確認した。複数撮影は参照した画像を表示し、未保存時には生成中と表示しない。

共通の受付/outboxには既存confidentialFieldsを使い、依頼、開始URL、自由入力の回答を保存しない。意味解釈の専用分岐は追加していない。通常会話の自動候補への有効化、旧経路の置換、追加live API検証は今回行わない。

検証範囲、失敗からの修正後の結果、ソースhash、重複する試験件数と残る制限は[検証記録](verification/browser-interact-2026-11-06/README.md)を参照。Context MCPは本体統合分でcontext_compile 1回、compile_eval 1回。
