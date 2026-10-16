# OCR文字起こしのLLM補正案と確認画面

状態: 実装済み・固定試験済み。実LARMでの品質受入は未実施。作成日: 2026-10-14。

対象は画像ファイル・撮影画像・短い動画の既存OCRアーティファクト。補正を担当する「SubAgent」はEumenes内で版付きProfileとSkillを持つ専門実行単位を指す。この設計作業で別のCodexチャットへ仕事を送る意味ではない。ボタンから直接起動するため、**補正専用ツールチェーンは登録しない**。会話経由で開いたOCR画面にもボタンを表示するため、既存`ocr.manage`の表示先revisionだけは更新する。登録と検証は[ツールチェーン登録](../../docs/toolchain-extension.md)と[検証手順](../../docs/toolchain-extension-verification.md)に従う。

## 1. 目的と完了条件

OCR完了後に利用者が「補正案を作る」を押すと、元画像とOCR結果を参照したSubAgentが誤字脱字、空白・改行、読み順、表の行列を見直す。補正は新しい候補として保存し、原文を変更しない。利用者は原文と補正案を比較し、必要なら採用・取り消し・会話への追加を明示的に行う。

完成の条件は、画像と動画の選択中フレームで補正案を作れること、表をセル構造で確認できること、判読不能な箇所が推測で埋まらないこと、履歴から候補と原文を再表示できること、利用者分離・取消・資料削除後の古い応答の排除を確認すること。現行の`recheck`は失敗したOCR jobの再確認だけなので、完成済み資料の再解析はこの計画の対象に含めない。品質はfixtureの成功だけで判断せず、正解を人が付けた日本語画像・表・動画フレームで評価する。

## 2. 現状と利用する機構

| 現状 | 根拠と判断 |
| --- | --- |
| OCRは元ファイル、原文、行のconfidence・polygon、動画フレームと時刻を保存する | [`docs/ocr.md`](../../docs/ocr.md)、`api/domains/ocr/contracts/index.ts`、`repository/index.ts`。原本と位置を補正入力・比較表示の根拠にする |
| OCR画面は元資料と結果欄を表示し、コピー・会話への追加ができる | `packages/design-system/src/components/OcrWorkspace/OcrPanel.tsx`、`web/src/domains/ocr/use-ocr-runtime.ts`。既存の履歴と画面を拡張する |
| 現行の`ocr.manage`は原文を読む・開く・取消を担当し、補正は未定義 | `api/domains/capabilities/bundles/ocr.bundle.json`。旧revisionを変更せず、新しい定義とartifact revisionを登録する |
| LLMの型付き出力、版付きProfile/Skill、キュー、取消後の受理判定がある | `api/domains/image/service/handlers.ts`、`api/domains/capabilities/service/bound.ts`、`api/domains/inference`。ただし画像生成の`captureControlInTransaction`は会話実行中の親要求を要する。ボタンには認可済みUI操作を起点とする独立した制御要求が必要 |
| LARMの会話入力は画像を受けられるが、visionとchatInput契約・容量制限が必要 | [`docs/chat-images.md`](../../docs/chat-images.md)、`api/domains/larm/service/chat-input.ts`。保存済み接続先の能力を実行時に検査する |
| OCRはWebPと動画を受けるが、LLM入力はJPEG/PNG/BMP画像。backend側の動画フレーム抽出経路は見つからない | `api/domains/larm/contracts/chat-input.ts`と現行source検索。形式変換と動画から正確な時刻の1フレームを得る処理を先行させる |

[共通資料](https://chatgpt.com/space/page_e38fb71deba88191bcefebcaa046ea60)はOCR原文の保存と、訂正・分析を別操作にすることを指定している。本機能はその別操作として追加する。元OCR APIの契約やLARM接続先を変更しない。

## 3. 操作と画面

1. OCRの`completed`資料を開く。画像では全体、動画では画面で選んだ1フレームを対象にする。選択中の行は比較箇所の強調に使い、初版で部分補正の入力範囲にはしない。
2. 結果欄の「補正案を作る」ボタンを押す。画像とOCR原文をLLMへ渡すことをボタン付近で示す。実行中・混雑・失敗・取消可能を表示する。二重押下は同一操作として扱う。
3. 完了後、元資料、OCR原文、補正案を並べて確認する。表は行・列・セルで表示し、必要に応じてコピーできる。各段落・セルの根拠となる元画像の領域またはOCR行を選ぶと対応箇所を強調する。どちらの根拠も示せない候補は採用可能な案として扱わない。
4. 「この案を採用」でその資料・フレームの既定表示とコピー対象を補正案に切り替える。原文への切替と別案の作成も可能にする。採用してもOCR原文や元ファイルは上書きしない。
5. 「補正案を会話に追加」は採用中または画面で選んだ案を明示して実行する。既存の原文コピー・原文の会話追加はラベルを明示して原文のまま利用できる。補正案を会話へ渡す際は「LLM補正案」であること、元資料ID・フレーム時刻・判読困難箇所を含める。履歴では資料ごと・動画フレームごとに補正状態を復元する。

候補の根拠が薄い箇所を目立たせる。OCRのconfidenceやLLMの自己申告を正答確率として表示しない。対象フレームを切り替えた後は、別フレームの補正案を現在の結果として表示しない。将来、完成済み資料の再解析を追加する場合も版の違う案を混ぜない。

## 4. 補正SubAgentと責務

版付きの`ocr.correct` Profile、Skill、Packageを登録する。これは主会話から独立した一回の専門推論と型付き結果を持つSubAgentであり、不要な自律tool loopは追加しない。現行のPackage契約はtool参照を要するので、Packageは既存OCR読取りtoolを依存に含める。今回の固定入力型の補正実行ではモデルにtool callingを開かず、OCR domainの認可済み読取りでsnapshotを組み立てる。補正依頼の入力schemaは元資料ID、期待するOCR revision、動画のframeIndexを検証する。workerは作成した補正run IDを`rootRunId`と`taskId`に結び、保存した正確なPackage revisionからSystemContextを構成する。ボタンは登録されたartifact actionからOCR domainの公開APIへ入り、キューに投入する。会話の意図選択機構をボタン処理へ重ねない。将来、会話からの補正指示を受ける場合だけ、同じ公開操作へつなぐ型付きtoolと補正用toolchainを別に検討する。

SubAgentへ渡すのは、認可済みの元画像または選択フレーム、OCR原文・行と位置、元資料の寸法、出力契約だけ。ファイル名やOCR中の文は指示ではなく資料として扱う。Profile/Skillには、見える文字の忠実な復元、スペース・改行・読み順の修正、表の行列と結合セルの復元、固有名詞・数値・単位の保全、不確実な箇所の明示、見えない情報の創作禁止を記す。対象語句や特定の誤認識に対する製品コードの辞書・正規表現分岐は作らない。

出力契約は段落・表のblock列を基本とし、表は行・列indexと必要な結合範囲を持つセル列で保持する。各block/cellにOCR行indexの集合または元画像内の領域を根拠として付け、判読できない文字には`uncertain`と説明を付ける。元OCRに存在しないが画像で読める文字は領域を根拠にできる。OCR行を統合・除外した場合も対応や除外理由を示し、入力に含めた行が無言で消えないようにする。コードはblock数、文字数、index、領域、表の重なり・範囲、入力行との対応、JSONの形を検証する。修正文の意味や正しさを固定ルールで判定しない。コピー用の平文はこの構造から生成する。結合セルを含む表の表示をMarkdownだけに依存しない。

## 5. 保存・API・実行

- OCR domainが候補の所有者になる。元資料ID、owner、conversationId、フレームindexと時刻、元結果のrevisionとdigest、要求ID、Package revision、状態、構造化補正案、作成時刻を保存する。候補は完成後に不変とし、資料・フレームごとの採用候補IDは別に記録する。履歴はページングして読み、候補の件数・保存量に実測に基づく上限を設ける。上限時は理由を返し、採用中の案を黙って削除しない。失敗jobの`recheck`中は補正を受け付けず、将来完成済み資料の再解析を追加する場合は版の違う候補を現在版へ自動採用しない。削除時は候補と進行中jobを片付ける。元画像の複製とProviderの生応答、資格情報は補正候補に保存しない。
- 公開APIは候補作成、一覧・詳細、取消、採用または原文への切替を提供する。作成にはrequestId、対象のframeIndex、期待するOCR revisionを要求し、同じrequestId・同じ入力は同じreceiptを返す。異なる入力での再利用は競合にする。同じ資料・フレームの処理中候補はDB制約または同一transactionの検査で一件に限定する。採用切替には採用状態の期待revisionを要求し、別タブの更新を黙って上書きしない。元資料に対する既存のowner検査に加え、UI操作が属するconversationIdと資料のconversationIdを照合する。ブラウザはAPIを使いDBを直接開かない。
- キューworkerは`inference.llm`資源で実行する。現行の`captureControlInTransaction`は会話実行中の親要求が必要で、`captureMaintenanceControlInTransaction`は保守作業向けで出力上限が小さい。UIの受付receiptとowner、補正run、期限に結び付ける制御要求の入口をinference domainへ最小追加する。`prepare`で元資料と版、Package、保存済みLARM設定、画像入力契約を確認する。`execute`では画像とOCR観測を添えた型付きLLM要求を行う。`settle`ではsource revision/digest、取消状態、能力登録とinference receiptの受理を再確認して候補を保存する。取消・削除時は待機jobを止め、実行中のLLM要求も中断する。遅い応答を採用しない。通信切断時は取得済み候補IDで状態を再照会し、未確認POSTを自動再送しない。
- WebP等はbackendで対応する画像形式へ変換し、EXIFの向き・透明部分・寸法・容量を確認する。変換や縮小時はOCR polygonとの座標対応を保持する。動画は保存済み元動画から選択されたOCR時刻の1フレームをbackendで抽出する。抽出画像の実時刻とOCR時刻の許容差を決めて試験し、合わなければ補正を実行しない。利用可能な抽出手段は実装着手時に環境と配備要件を確かめて決める。
- vision能力や画像・総要求bytes・token・出力予算の上限を満たすLLMがない場合は実行不可の理由を返す。LARMのモデル名・profile名・接続先をコードに固定しない。画像の一部、OCR行、表のセルを黙って省略して「全体を補正した」としない。上限を超える資料は明示的に受け付けず、全体処理に必要な分割と元座標への再統合は別revisionで設計する。

候補の状態は`queued → running → completed | failed`、取消時は`queued | running → cancelling → cancelled`とする。`completed`は構造と根拠の検証まで通った案だけを指す。LLM出力の構文・契約違反は`failed`にし、原文を表示したまま再試行を案内する。既に処理中の同じ資料・フレームへの新規依頼は受け付けず、完了後の再実行は別のrequestIdで新候補を作る。取得APIは状態・失敗分類・候補IDを返し、Webは現行OCRと同様に再照会する。取消は候補だけに作用し、元OCR jobの取消と混同しない。

会話への追加は既存のOCR会話追加経路と同じくEumenes側で行い、候補ID・source revision・frameIndexを再検証してから補正案を渡す。大きな案を黙って切り詰めず、現行の会話入力上限に収まらなければ理由を返す。本文、元画像、Provider生応答を通常ログへ出さず、候補ID・queue job ID・inference request IDと分類した状態で追跡する。LARMの画像保持方針は実行時の`chatInput.retention`に従い、ボタン周辺の説明と矛盾させない。

## 6. 登録・UI・検証の作業順

1. OCR sourceのrevision/権限/取消・再解析挙動、LARM vision入力と保存方針、動画フレーム抽出の配備可能性を確定する。ここで入力サイズと1フレーム当たりの処理時間を測る。
2. `ocr.correct`のProfile/Skill/Packageと入力・出力schema、候補保存と公開APIをOCR domainに追加する。既存の`ocr.manage`定義本文と旧revisionは保持する。
3. 既存キューと新しいUI起点の型付きinference制御要求でSubAgentを実行し、取消・版変更・権限変更時の受理拒否を結合する。画像変換と動画フレーム抽出を接続する。
4. `ocr.workspace`の新revisionへ補正作成・取消・採用のaction bindingと比較表示を登録する。DesignSystem、artifact-ui bridge、Web runtime/clientをつなぐ。現行`ocr.manage`のbindingとtoolchainを新しいartifact revisionへ向ける新revisionを登録し、旧revisionは変更しない。launcherと会話経由の両方で同じ画面が開くことを確認する。補正専用toolchainは作らない。
5. 部分検証 → OCR/API/queue/LARM契約の結合検証 → 対象ブラウザE2E → 保存済みLARM接続でのlive確認の順で行う。`bun run verify -- --domain ocr`に加え影響を受けるcapabilities、inference、artifact等のdomainを選ぶ。ブラウザE2EはOCRの試験ファイルを個別実行する。fixture、live、実機器の結果を分けて記録する。

回帰例には日本語の誤字、語間スペース、縦横の読み順、罫線なし・結合セル付きの表、数値・単位・固有名詞、判読不能箇所、OCRが見落としたセルを含める。人手正解を付けた集合全体で文字誤り率が元OCRより改善することを確認し、元から正しい箇所の悪化、表の行列・セルの一致、重要な数値の新たな誤補正、`uncertain`の付け忘れを個別に記録する。受入試験では原文不変、明示採用、原文と案の会話追加の区別、履歴復元、別利用者の拒否、同じrequestIdでの再送と入力競合、同フレーム同時依頼、取消、資料削除後の遅い応答、動画のフレーム対応、LLM出力不正、入力上限超過も確認する。

## 7. 実装時の境界

実装ではOCRの推論モデルや認識APIを置き換えず、既存原文の取得と履歴を維持する。全動画を一度に補正した結果や、文脈からの欠損文字の断定は提供しない。動画は選択中の1フレームごとに補正する。表は見た目だけのMarkdown文字列ではなくセル構造として保存する。

## 8. 実装と確認（2026-10-14）

`ocr.correct@1`のProfile・Skill・Package、`ocr.workspace@4`、`ocr.manage@4`を登録した。OCR domainに候補保存・採用状態・公開APIを追加し、キューの`inference.llm`資源からLARM visionへ画像とOCR観測を送る。独立したUI起点の型付き推論要求はinference domainへ追加した。画像変換と動画フレーム抽出をbackendで行い、時刻差・寸法・入力容量・構造・根拠・入力行の対応を検査する。DesignSystem、Artifact bridge、Web runtimeに比較・履歴・採用・原文復帰・会話追加・根拠強調を接続した。

固定試験はOCR domainの19件（補正の画像・動画・不正根拠・表セルの結合と重複・取消・HTTP会話境界・同時依頼・JPEG/BMP入力・会話追加時の不確実性を含む）、inferenceの独立制御要求、OCRブラウザの2件（補正UIはAPI応答を固定）を通した。コードレビューでは補正担当への出力契約の伝達、失敗した推論要求の取消、接続先が指定する画像形式と容量、表のコピー時の列位置、会話へ渡す動画時刻、同時依頼の応答、表の判読困難箇所と除外理由の表示を修正した。DesignSystem buildとbundle検査も通過した。`verify --domain ocr`は選択型検査で既存の`@/utils/cn` path alias解決に失敗する。全体typecheckはOCR以外の作業中ファイルにエラーが残る。`verify --domain inference`は試験まで通過したが、実行中に他の変更が入り入力revisionが変わったため結果は無効である。保存済みLARMへのlive接続、人手正解付き日本語資料の品質評価、実カメラは未実施。
