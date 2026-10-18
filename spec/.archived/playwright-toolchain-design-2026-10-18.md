# Playwright ツールチェーン設計

作成日: 2026-10-18

状態: 置換え（2026-10-18）。専用Chromiumを管理する方式は、利用者の普段のBraveをPlaywright MCP Bridge経由で操作する方式に置き換えた。現行は[ブラウザのタブ操作ツールチェーン設計](../browser-tabs-toolchain-design-2026-10-18.md)。

関連: [登録と拡張の手順](../docs/toolchain-extension.md)、[検証手順](../docs/toolchain-extension-verification.md)、[サブエージェントの二つの型](subagent-task-and-session-agents-design-2026-10-18.md)、[LARM](../docs/larm.md)、[画像ライブラリー](../docs/images.md)、[Claude Code画面](../docs/terminals.md)。

## 1 目的と決定事項

ブラウザのタブで開いたページを、会話から操作できるようにする。同じブラウザとタブを使って画面を撮影し、保存した画像を表示・取得できるようにする。

| 責務 | 入力 | 完了条件 |
| --- | --- | --- |
| ページ操作 | 利用者の依頼、対象タブ、必要なら開くURL | 実際のページを観測しながら操作し、実行結果または停止地点を通常担当へ返す |
| 画像キャプチャー | 対象タブ、撮影範囲 | 指定範囲を撮影し、非可逆WebPへ変換する。ローカル保存とLARM保存の結果を区別して返す |

利用者と決めた事項:

- 二つの責務でブラウザセッションとタブを共有する。操作担当と撮影担当が別々のページを開き直さない。
- 画像はLARMへの送信前に非可逆WebPへ変換する。**品質は75固定**とし、モデル・画面・依頼ごとに変えない。
- ローカル保存にも、LARMへ送るものと同じWebPを使う。
- PNG比80%削減を目標とするが、品質を自動で下げたり、容量を理由に撮影範囲を変えたりしない。画像ごとの80%削減は完了の必須条件にしない。
- LARMの画像ライブラリーを最終的な画像の正本にする方針。外部画像の登録APIは§7の契約確認が必要。

利用者の指定により、幅・高さのどちらかが2,500pxを超える撮影は`capture_dimensions_exceeded`で拒否し、自動縮小・分割保存を行わない。2,500pxちょうどは許可する。単発型の出力・文脈・予算を既存のサブエージェント設計§6へ合わせる方針は、本改訂案の合意対象とする。

本書の対象外は、動画録画、ブラウザ拡張、任意スクリプトの実行、利用者の既存Chromeの履歴・Cookieの自動取込み、他ツールチェーンの移行、画像生成・画像編集、OCRや3D生成の自動起動とする。

## 2 既存機構と追加が必要な範囲

| 再利用先 | 再利用する内容 | 現行の境界 |
| --- | --- | --- |
| capabilitiesのbundleと登録adapter | 担当選択、profile・SKILL・tools、版の凍結、可用性、Artifact登録 | ブラウザ用の登録は新設する。旧形式の固定runtime mapには追加しない |
| command担当 | 一件の依頼を操作受付か確認質問へ変換する | `dialogue/service/toolchain-command.ts`は1推論・1操作。観測してから次の操作を選ぶループではない |
| queueとinferenceの公開操作、サブエージェント設計§6 | prepare・execute・settle、期限・取消、receipt検証、単発型の出力・文脈・予算 | commandの多段実行と共通核の単発型への適用は未実装。§5.4の最小拡張を先に行う |
| 既存の非同期domainと会話通知 | 受付を保存してジョブを進め、commit後に通常担当へ完了を知らせる | 受付成功をページ操作や撮影の完了として答えない |
| sharp | PNGからWebPへの変換 | 既存依存は0.35.5。会話添付の正規化はJPEG/PNG等を対象とする別契約で、保存用WebPの経路へ流用しない |
| LARMの画像ライブラリー | 画像一覧・詳細・取得・削除とControl認証 | `larm/service/image-library.ts`に外部画像の登録操作はない。3D・画像選択向けの[画像取込API提案](reference/larm-image-import-v1-proposal/README.txt)があるが未公開・未実装 |
| DesignSystemとOpenUI | 一覧・状態・プレビュー・ダウンロード、JSONからの画面構成 | ブラウザのタブ・実行状態を扱うsourceと操作を追加する |

ページ操作は外部の状態を一手ずつ観測して進めるため、bundleだけでは実現できない。ブラウザの実体・参照・操作受付を所有するdomainと、Playwrightへの接続が必要である。一方、担当選択・推論通信・キュー・結果通知を別方式で作り直す必要はない。

協働型の`session`は採用しない。ブラウザセッションを保持することと、会話の相手を専門担当へ引き継ぐことは別である。一件の操作依頼を単発タスクとして完結させ、続く依頼には同じタブのrefを渡す。作業文書・保存・Undoの契約を持つUI自由制作には載せない。共有ツール・非同期ターン起動のP3も未実装のため前提にしない。

## 3 全体構成

以下のID・ファイル・APIは新規実装の予定名であり、現行の公開機能ではない。

```text
会話 → browser_operate / browser_capture → command担当
  → command binding → adapter:browser@1
  → browser domainの公開transaction操作（受付・receipt・queueを保存）
  → queueの実行段階 → Playwright / sharp / LARMの画像登録port
  → 結果を検証してbrowser domainへ保存 → commit後に会話通知・画面更新

画面 → 共通toolchain-actions → 同じadapterとdomain
画像表示 → 認証済みAPI → ローカルWebPまたは既存LARM画像取得経路
```

| 所有するもの | 置き場所案 |
| --- | --- |
| タブ目録、タスク、操作・撮影・送信の台帳、状態遷移、HTTP API | `api/domains/browser/` |
| Playwrightの起動・タブ・観測・操作、画像変換 | `api/domains/browser/adapters/`。domainのportを実装する |
| domain間の接続と登録adapter | `api/application/browser/browser-adapter.ts`と同ディレクトリの組立て |
| 担当・ツール・binding・Artifact・schema | `api/domains/capabilities/bundles/browser.bundle.json` |
| LARM画像登録のHTTP契約・クライアント | `api/domains/larm/contracts/image-library.ts`と`service/image-library.ts`の追加操作。既存schemaは互換性を維持する |
| ブラウザ画面の表示部品とOpenUI登録 | `packages/design-system`、`packages/artifact-ui` |
| Web adapter | `web/src/domains/browser/toolchain-adapter.tsx` |

browser domainはLARM・dialogueのrepositoryやDBへ直接アクセスしない。画像登録・推論・完了通知はportとしてapplicationから注入する。複数domainの保存は単一writer transactionと各domainの公開操作で行う。ブラウザやLARMとの通信をwriter transactionへ入れない。

## 4 ブラウザとタブの管理

### 4.1 接続対象の提案

初期版はbackendと同じホストにある専用ChromiumをPlaywrightで管理する。利用者の普段のChromeへ自動接続しない。新規タブはこのブラウザ内に開き、利用者が見られるウィンドウを使う案とする（§12 Q1）。外部サイトをEumenesのiframeへ埋め込む方式は採らない。

ブラウザのタブと、EumenesのArtifactタブを区別する。Artifactはブラウザのタブ一覧・作業状況・撮影結果を表示する管理画面であり、初期版ではWebページの常時映像配信を行わない。backendが別ホストにある場合、その画面を利用者へ見せる方法は別途合意する。

起動・終了は製品機能として利用者がブラウザを開く・閉じる操作をしたときのライフサイクルとする。実装・検証作業で既存サーバーを停止・起動・再起動する許可にはしない。

### 4.2 参照と競合

- hostが`browserSessionRef`・`tabRef`を発行する。会話・UIとも所有者と有効期間を検査し、URLや画面上の順番だけでタブを指さない。
- ページ操作と撮影は同じ`tabRef`を使う。タブが閉じられていれば失敗とし、似たURLのタブへ勝手に置き換えない。
- タブごとに実行を直列化する。別のタスクが所有している間は`tab_busy`とし、操作・撮影を割り込ませない。
- 観測ごとにhostが`observationRef`と遷移世代を発行する。要素refはPlaywrightの`ariaSnapshot({mode:"ai"})`の値を再利用し、自前の要素ID体系を作らない。`observationRef`・タブ・世代と組にして検査し、別のタブで同じref文字列が出ても同一視しない。遷移・タブの再作成・既知の画面変更後は失効させ、候補が変わった場合は再観測する。
- 自動待機、locatorの一意性・操作可能性の検査はPlaywrightへ委ねる。曖昧な一致から先頭を選んだり、モデル生成のCSS/XPathで未観測の対象を操作したりしない。
- backend再起動でブラウザの実体との対応を失ったタブは失効させる。保存したURLだけで操作を再現せず、実行中だった操作は結果不明として扱う。

### 4.3 ページとbackendの境界

専用browser contextへEumenes・LARMのtokenやbackendの環境変数を渡さない。URLはHTTP/HTTPSを対象とし、ローカルファイルやブラウザの内部ページを開くschemeは拒否する。localhostや私設ネットワークへの接続は明示した許可範囲だけにし、試験のloopback許可を製品へ流用しない。

| 通信経路 | hostで強制する境界 |
| --- | --- |
| DNSとTCP接続 | 接続を仲介するegress proxyが接続の都度A/AAAAの実IPを検査し、許可したIPへ接続する。名前を事前解決してからブラウザに再解決させる方式にはしない。IPv6・IPv4射影・loopback・私設・link-local等を検査し、DNS rebindingで未許可IPへ変わったら拒否する |
| 遷移・リダイレクト・iframe・ポップアップ・fetch等 | 最初のページを作る前にcontext単位のrouteを登録し、URL・origin・ポートを検査する。下位のegress制約も同時に適用し、許可外は通信前に止める |
| WebSocket | ページ作成前に`browserContext.routeWebSocket`を登録する。ws/wssの接続先にも同じDNS/IP・origin制約を適用し、許可するものだけ接続する。既存接続を後から捕捉できる前提にしない |
| Service Worker | 新規contextを`serviceWorkers:"block"`で作り、永続contextや既存Service Workerを再利用しない |
| WebRTC・直接UDP・QUIC等 | 通常のrouteで捕捉できると扱わない。初期版ではWebRTCを提供せず、ブラウザプロセスのネットワーク隔離でproxyを経由しない外向き接続を拒否する。JavaScriptの上書きや起動flagだけを安全性の根拠にしない |

proxyの設定だけで直接通信がなくなるとは保証しない。プロセスのネットワーク隔離と、ブラウザから接続可能なproxy・制御口の範囲を技術検証で確かめる。実際のOSでこれを強制できない場合は`browser_network_boundary_unavailable`として利用不可にし、通常通信へ切り替えない。隔離の導入にOSの権限・設定変更が必要なら、その具体的変更を示してから許可を得る。

Service WorkerとWebSocketの扱いは[Playwrightのcontext仕様](https://playwright.dev/docs/api/class-browsercontext#browser-context-route)に従う。routeだけで全通信を制限できるという前提は置かない。

Cookie・認証状態は専用contextに閉じ込め、別の所有者や失効したセッションへ引き継がない。ページが要求するダウンロード・ファイル選択・カメラ等の権限を自動で許可する機能は初期版に含めない。ローカルWebPの取得APIも所有者を検査し、capture IDから管理下の保存参照だけを解決する。

### 4.4 製品実行環境と可用性

現行`package.json`にあるのはdevDependencyの`@playwright/test:1.61.1`であり、API製品コードの実行時依存ではない。実装時は**`playwright-core:1.61.1`をdependenciesへ追加**し、製品コードはそこからimportする。`@playwright/test`やCodexの同梱runtimeに依存しない。

Chromium本体は配備時に、固定版パッケージのCLIで`bun ./node_modules/playwright-core/cli.js install chromium`を実行して専用の配置先へ入れる。起動時にはダウンロードしない。`PLAYWRIGHT_BROWSERS_PATH`で配備先を明示し、backendにも同じ場所を渡す。LinuxのOS依存ライブラリは配備手順で準備し、自動で管理者権限のインストールを行わない。

ブラウザは[1.61.1のbrowsers.json](https://github.com/microsoft/playwright/blob/v1.61.1/packages/playwright-core/browsers.json)が指定するChromium revision **1228**、browserVersion **149.0.7827.55**を基準とする。利用者のChromeや任意の`executablePath`で代用しない。更新はパッケージと対応ブラウザを一組で行い、再検証する。

実行候補はプロジェクト指定のBunで`playwright-core`を直接使う構成だが、headfulウィンドウ・終了・取消まで正常に動くとはまだ確認していない。§10 S0のspikeを先に行い、失敗時は製品実装を進めず、Node.js worker等への変更案を別途提示する。フォールバックを自動導入しない。

`availability:browser@1`は、実行時依存・対応ブラウザの存在と版、表示環境、管理領域の書込み、通信境界、同じruntime・ブラウザ・OS構成での起動検証記録から作る。readinessの確認・更新はtransaction外で行い、adapterは保存した状態を読むだけにする。実行ファイルや隔離設定が変わった、確認が失効した、起動に失敗した場合はfalseにする。正常に未起動の状態は利用可能とし、実体が切断した既存タブだけを失効させる。catalog参照や画面の表示だけでプロセスを起動しない。LARMへの送信可否は別の能力状態とし、ローカル撮影の可否から分離する。

### 4.5 タブ所有権のlease

タブを保持するtask IDとともに、`leaseEpoch`・`leaseExpiresAt`・現在のjob/attempt IDを保存する。初期案はlease 30秒、実行中は10秒ごとに更新し、元のタスク期限を超えて延長しない。queueのleaseは各ジョブのものなので、タブ所有権の代用にはしない。

ジョブ間の引継ぎとlease更新は、現在のtask・epochが一致するときだけwriter transactionで行う。各副作用の直前と結果採用時も同じ組を検査する。終端・取消・失敗時は解放し、期限切れは定期回収と新規取得時の両方で検出する。

lease期限切れで、旧workerがまだ動いているタブを別タスクへ直ちに渡さない。epochを進めて旧workerを失効させ、実行の中止とタブ／contextの終了を確認してから再利用可能にする。終了が確認できなければ`tab_quarantined`として隔離し、`tab_busy`の永久残留にも、二重操作にもさせない。実行済みかもしれない操作は`indeterminate`で止める。回収後は新しいタブrefを発行し、古いworkerの遅い結果を採用しない。

## 5 ページ操作タスク

### 5.1 登録と実行

入口は`toolchain:browser.operate@1`、会話関数`browser_operate`、`package:browser.operate@1`、`binding:browser.operate@1`（`execution:"command"`）とする。packageのprofile・SKILLが、依頼の解釈、対象タブの選択、不足情報の質問を担う。

| 登録 | ページ操作 | 画像キャプチャー |
| --- | --- | --- |
| profile・skill | `profile:browser.operate@1`・`skill:browser.operate@1` | `profile:browser.capture@1`・`skill:browser.capture@1` |
| useWhen | 指定ページを開く、現在のタブを読み取って操作する | 現在のタブ・ページ全体・指定要素を画像として保存する |
| examples | 「このタブで商品名を検索して」「このページの次の項目を開いて」「指定したURLを開いて内容を確認して」 | 「今のタブを撮って」「ページ全体を画像にして」「この図だけキャプチャーして」 |
| redirects | 公開情報の検索・本文取得だけで足りる依頼は既存Web調査へ | 新しい絵や写真を作る依頼は画像生成へ |
| 結果契約 | `domain:browser.receipt@1`・`projection:browser.task-result@1` | 同じreceipt schema・`projection:browser.capture-result@1` |

共通の可用性refは`availability:browser@1`とする。bindingのtoolsは各packageのtoolの部分集合とし、入力schema参照をadapterと一致させる。bundle外の依存はrevisionとdigestでpinする。

command担当へ公開する操作は、`browser.task.start`・`browser.task.status`・`browser.task.cancel`・`browser.workspace.open`とする。開始入力は平坦objectで、`request`と任意の`tabRef`・`url`を受け取る。既存タブの操作なら`tabRef`を使い、URLを渡しただけで同じページを別タブへ開き直さない。対象が不明なら既存interactionsで質問する。

受付のreceiptは`taskId`と`accepted`を返す。通常担当は「操作を始めます」と答え、最終結果は後続の通知で伝える。ページ内の内容に応じた振り分けをdialogueへ追加しない。

### 5.2 観測と次の一手

受付後は、ブラウザ操作用の実行package `package:browser.page-operator@1`のprofile・SKILL・ツール契約を凍結して使う。受付packageのdependenciesにこのpackage revisionを含め、hostはその固定依存から実行packageをprepareする。IDだけで最新の公開版を取り直さない。受付用packageとは分け、commandの1操作という契約を変更しない。

1. browserのジョブがタブを観測し、URL、タイトル、表示テキスト、アクセシビリティ情報、要素ref、残り予算を得る。
2. 既存inference portへ現在の依頼と観測結果を渡す。LLMが次の操作一つか、完了・不足・失敗を選ぶ。
3. hostが引数・対象・権限・世代を検査し、操作受付を保存する。
4. transaction外で操作し、結果を照合して保存する。次の観測が必要なら新しいジョブを積む。
5. 目的達成時に短い結果と根拠となる観測refを返して終える。

実行ツールは、タブ一覧、新規タブ、遷移、戻る・進む、観測、クリック、文字入力、選択、キー入力、スクロール、待機と共通の撮影操作を最小集合とする。クリック等は観測済みの要素ref、スクロールは対象と量、待機は契約で制限された条件・時間を受け取る。任意コードを受け取る`evaluate`や任意のローカルファイル指定は公開しない。

ページの意味理解、操作順、結果の解釈はLLMへ委ねる。hostは要素名の辞書、サイト別手順、発話の正規表現、固定クリック列を持たない。ページ本文は取得資料として囲み、profileや利用者の指示として扱わない。

現行commandには多段実行がなく、researchの実行は資料・根拠の契約を持つ。browser固有に追加するのは、外部操作の受付・実行・観測とqueueへの接続である。推論の文脈・出力・終了・修復・予算は§5.4の共通契約を使い、browser専用の第三のエージェント契約や研究資料用の架空の参照は作らない。

### 5.3 権限と不明な結果

外部への送信・購入・公開・削除などは、現在の利用者の依頼で許可された範囲だけ実行する。LLMは許可範囲と実行予定を示し、不足する許可は質問する。hostは承認を対象タブ・操作内容・世代に結び付け、内容が変わった操作へ流用させない。確認済みの同じ内容について毎回聞き直さない。初期版に含める確定操作の範囲は§12 Q2で決める。

**フォームへの入力も外部への情報送信として扱う。** 入力中のJavaScriptによる送信を止められる前提にしない。hostは、利用者が外部ページへの入力に使用してよいと指定した値だけに`inputValueRef`を発行し、task・許可origin・用途・期限へ結び付ける。LLMのfill/type操作は生の文字列ではなくこのrefを指定する。user入力の指定箇所との一致、明示承認済みの値との一致をhostが検査する。

ページ本文・観測結果・別の会話・backend設定・Cookie・認証情報から取得した値には、この権限を付けない。**現在の依頼文から抽出・整形した値（検索語の言い換え等）は許可済みとして扱う**（2026-10-18 利用者決定）。LLMは値ごとに依頼文中の出所を示し、hostはその値を依頼由来のgrantとして記録する。依頼文に出所を示せない値は、内容を利用者へ示して入力許可を得る。キー入力にも同じ規則を適用し、文字キーの連打・貼り付け・選択操作によって未許可の値を外へ出す抜け道を作らない。意味として何を検索するかはLLMが決め、hostは値の出所と許可を検査する。

外部Web操作にDBとの原子性やexactly-onceは保証できない。操作IDと入力digestを実行前に保存し、`prepared → dispatched → observed`を記録する。実行済みかもしれない状態で停止したら`indeterminate`とし、ジョブの再実行で同じクリックや送信を繰り返さない。再観測で結果を確定できない場合は、その地点を利用者へ報告して止める。

### 5.4 単発型エージェント核との整合

[サブエージェント設計§6](subagent-task-and-session-agents-design-2026-10-18.md#6-エージェント核)の単発型へ合わせる。

| 項目 | 本ツールチェーンでの契約 |
| --- | --- |
| 出力 | 一つの平坦objectと`action:invoke / finish / clarify`。操作と完了文を同時に返すbrowser独自形式にしない |
| 文脈 D7 | system＝profile・SKILL・共通規則・TOOLS・出力契約、userの参考資料囲み＝観測と既知のツール結果、最後のuser＝現在の依頼原文。後続の推論は前回assistantと囲んだTOOL_RESULTを追記する |
| 終了 | `finish`で結果を返す。`clarify`は`needs_input`で止めて質問を通常担当へ返す。返答後は許可と対象を再検査した新しい依頼として開始し、前タスクが勝手に継続しない |
| 予算 | 固定したbindingの`agent.turn.maxModelCalls:12`と`agent.turn.retries`を正本にする。browserの定数へ複製しない |
| 残り回数 | 毎回`callsLeft`を提示し、出力修復・拒否後の推論も同じ上限へ数える。単発型の最後の1回はfinish/clarify用に残すため、成功操作は最大11回となる |
| 再試行 | `agent.turn.retries.default:1`を初期案とし、未実行と確定した契約拒否だけ再検討を許す。dispatched後の結果不明は対象外。queueのretryで上限をリセットしない |

**現行コードとの差分:** `capabilities/contracts/bindings.ts`の`agent.turn`はsession bindingだけが受け付け、command bindingは受け付けない。サブエージェント設計P4の単発型統一も未実装である。本実装ではこの共通方針に沿い、command bindingにも任意の`agent.turn`を持てる最小拡張を行う。受付の1推論には適用せず、受付後に固定する単発タスクの実行policyへ渡す。既存のagent無しcommandは挙動を変えない。

出力schema・文脈構成・callsLeft・修復カウントの共通部を既存の核から再利用できる単位へ切り出し、browserの段階実行が呼ぶ。先にこの契約とfixtureを揃え、その後に操作を接続する。research全体の移行やP3の共有ツールは本作業へ広げない。共通化のために既存sessionへ変更が及ぶ範囲は回帰確認する。

### 5.5 観測量と要素ref

Playwright 1.61.1の[公開型](https://github.com/microsoft/playwright/blob/v1.61.1/packages/playwright-core/types/types.d.ts)には`ariaSnapshot({mode:"ai", depth, boxes})`があり、`[ref=e2]`のような要素refを含む。既存の`scripts/nl-acceptance/driver.ts`もこのsnapshotと`aria-ref=` locatorを使っている。この経路を再利用し、対象refの解決と失効はS0で確認する。

観測は初期値を「現在のviewport内」とし、LLMが要素・領域・スクロール先を指定して追加観測できるようにする。初期上限案は1観測32 KiB（UTF-8）、深さ12、操作候補200件。上限は登録した観測toolのschemaとhostの固定policyで共有する。可視性・矩形・木の深さ・byte数による機械的な制限にとどめ、hostが話題や語句で重要度を決めない。

制限時は、完全なノード単位で残せる範囲だけを返し、`truncated`・観測範囲・省略理由・続きの領域refを添える。途中で切れたrefを登録せず、提示した要素refだけを操作可能にする。全ページのsnapshotやDOM全文・innerText全文を先に無制限取得してから切り詰めない。固定したhostの可視領域走査と領域ごとのARIA取得に、訪問ノード数・取得bytes・時間の上限を設ける。ARIA APIのdepth指定だけでbyte上限が守れるとは扱わない。

推論の直前は既存inferenceの正式なtoken計数と、catalog/claim由来の文脈上限・出力予約で依頼・履歴・観測の総量を検査する。32 KiB以内でも収まらなければ、要求済みの領域をさらに限定する。利用者の原文、TOOLS、採用に必要な既提示結果を黙って削除しない。最小の観測でも入らなければ`observation_budget_exceeded`として止め、全体を見たと答えない。閾値の調整はS0/S2の実測で行う。

## 6 画像キャプチャー

### 6.1 登録と入力

入口は`toolchain:browser.capture@1`、会話関数`browser_capture`、`package:browser.capture@1`、`binding:browser.capture@1`（`execution:"command"`）とする。二つのtoolchainは同じ`adapter:browser@1`と`artifact:browser.workspace@1`を使う。

公開操作は`browser.capture.start`・`browser.capture.status`・`browser.capture.cancel`・`browser.capture.retry-upload`とする。撮影開始入力は`tabRef`、`range`（`viewport`・`full-page`・`element`）、任意の`elementRef`。`element`では現在の観測に属する要素refを必須とし、ほかの範囲では受け付けない。この関係はhostで検査する。品質・形式・任意ファイルパス・外部URLは入力に持たせない。

状態照会・取消・送信再試行はhostが発行した`taskRef`または`captureRef`を受け取る。snapshotにある候補だけを会話へ渡し、画面からも同じ所有者・有効性の検査を通す。

撮影を独立して頼む場合はこの入口を使う。「操作して、その結果を撮って」のような依頼は、ページ操作タスクが共通の撮影操作を呼び、同じタブのロックを保持したまま撮影まで進める。画像変換・送信処理を二重実装しない。

タスク内の撮影もbrowser domainの同じcapture受付・queueを使う。タスクに待機中のcapture IDを保存し、撮影・送信のsettleから次の段階を積む。待機中は推論要求を保持せず、撮影を再実行しない。タブの実行権は画像の撮影・遷移世代の照合まで保持し、WebP変換・LARM送信中は解放できる。これは同じdomain内のジョブ連携であり、未実装の専門担当の共有ツール機構には依存しない。

### 6.2 撮影と変換

```text
タブの実行権取得 → 指定範囲をPNGバッファへ撮影
  → sharpで非可逆WebPへ一回だけ変換
  → WebPをローカルへ保存・検査 → LARMへ同じバイト列を送信
```

| 項目 | 値・規則 |
| --- | --- |
| 形式 | WebP、`image/webp` |
| 圧縮 | `quality:75`、`lossless:false`、`nearLossless:false` |
| 圧縮処理の強さ | `effort:6`を初期案とする。品質75とは別の処理時間の設定 |
| 画素密度 | `scale:"css"`を初期案とする。ページのCSSピクセル等倍で撮影する |
| 撮影後の寸法 | 自動縮小・切り抜きはしない。範囲は依頼に従う |
| 各辺の上限 | 幅・高さとも1〜2,500px。どちらかが超えたら`capture_dimensions_exceeded`で拒否し、分割保存もしない |
| PNG | メモリ上の中間データのみ。通常の保存・送信・再送対象にしない |
| 保存名 | hostが発行したcapture IDから作る。モデル名・profile名・ページタイトル・URLをファイル名に使わない |
| 検査 | デコード、実寸、MIME、WebPの非可逆形式、容量、SHA-256 |

プロジェクトが指定するPlaywright 1.61.1の撮影形式はPNG/JPEGなので、PNGからsharpで変換する。[固定版の型定義](https://github.com/microsoft/playwright/blob/v1.61.1/packages/playwright-core/types/types.d.ts)を基準とする。最新版のWebP直接撮影を理由に依存を更新しない。sharpの設定は[WebP出力仕様](https://sharp.pixelplumbing.com/api-output/#webp)に従う。

撮影の前後で既知の遷移世代が変わった場合は採用しない。撮影した時点のタブ・URL・時刻・撮影範囲・実寸をcaptureへ結び付ける。ページ内の自動更新まで完全に凍結した画像であるとは扱わない。

libwebp 1.6.0の[WEBP_MAX_DIMENSION](https://github.com/webmproject/libwebp/blob/v1.6.0/src/webp/encode.h)は16,383であるが、本機能の上限は利用者が指定した各辺2,500pxとする。ページ全体撮影にも同じ上限を適用する。WebP形式や画像ライブラリーの受理schemaの上限を、そのまま本機能の撮影上限にはしない。

viewport・要素・ページ全体の予定実寸を**撮影前**に求め、各辺・画素数・メモリ予算を検査する。hostの固定処理で文書寸法等を読み、モデルへ任意evaluateを公開しない。撮影中にページが伸びた場合も、返却PNGのヘッダーをデコード前に再検査する。sharpにも画素数制限を設定し、巨大画像を無制限デコードしない。byte上限や処理期限の超過は`capture_resource_limit_exceeded`で止める。

超過時は予定寸法と上限を画面へ示し、viewportまたは要素撮影を利用者が新しく選べるようにする。全体撮影の依頼を部分撮影へ自動変更せず、分割保存を後付けのfallbackにしない。2,500pxを許す試験と2,501pxを拒否する試験は、幅・高さそれぞれで用意する。

### 6.3 容量の実測と目標

2026-10-18、Eumenesの既存ブラウザQA画像12枚（fixtureを含む）を、寸法変更なし、sharp 0.35.5・libwebp 1.6.0・effort 6で変換した。

| 品質 | PNG合計 | WebP合計 | 合計容量の削減率 | 各画像で80%以上削減 |
| --- | --- | --- | --- | --- |
| 50 | 2,495,769 bytes | 287,800 bytes | 88.47% | 6/12枚 |
| 75 | 同上 | 348,674 bytes | 86.03% | 6/12枚 |
| 80 | 同上 | 395,448 bytes | 84.16% | 5/12枚 |
| 85 | 同上 | 452,766 bytes | 81.86% | 4/12枚 |

品質75での各画像の削減率は66.58〜91.46%。比較した設定画面・記録表の日本語は読めるが、写真の細部は軟化した。一つのアプリの標本であり、外部サイト全体への削減率や知覚品質の保証ではない。利用者はこの結果を確認したうえで品質75固定を決定した。

詳細な入力・SHA-256・全72変換・比較画像・再現スクリプトは`verification-reports/playwright-webp-2026-10-18/`（ローカル検証出力、Git管理外）。実装時の回帰試験には権利・秘密を確認した小さな固定入力を別途用意し、このローカル出力の存在を試験の前提にしない。

## 7 LARMの画像登録契約案

### 7.1 必要な外部契約

既存の一覧・取得・削除と同じLARM画像ライブラリーに、外部WebPを登録する操作を使う。保存済みControl接続先とbackend内の既存Bearerを使い、生成用catalogの探索・モデル起動・Provider claimは行わない。LARMに同等の公開APIがあればその契約を優先する。

3D・画像選択向けに、LARMへの[画像取込API v1提案](reference/larm-image-import-v1-proposal/README.txt)（[OpenAPI案](reference/larm-image-import-v1-proposal/openapi.json)）が既にある。撮影画像のために別の登録endpointを提案せず、**同じ取込APIを使い、撮影に必要な差分だけをその提案への追加として出す**。いずれも未公開・未実装であり、パス・上限・再送規則はLARM側の仕様で確定する。

| 項目 | 既存の取込提案をそのまま使う部分 |
| --- | --- |
| 登録 | `POST /v1/image-artifacts/imports`、`multipart/form-data`、fileちょうど1個 |
| 冪等性 | 受付時に保存したIdempotency-Key。同一キー・同一bytesは同じ成果物、別bytesは409 `idempotency_conflict` |
| 応答 | 新規201、成功再送200、処理中202と`requestId`・`expiresAt`。成果物は既存imageArtifact形式 |
| 結果照会 | `GET /v1/image-imports/{requestId}`で通信断・再開後の成否を確定する。キーと結果は7日以上保持 |
| 上限 | 16 MiB、各辺8192px、総画素数33,554,432。本機能の各辺2,500px上限はこの内側にある |
| 拒否・容量 | 不正画像・上限超過・認証失敗・507容量不足を区別し、既存画像を勝手に削除しない |

| 項目 | 撮影のために取込提案へ追加を求める差分 |
| --- | --- |
| WebPの保存 | 取込提案は全入力を静止PNGへ正規化する。これではLARM側の保存がPNGとなり、品質75固定WebPと容量削減の目的、送信bytesとのSHA-256照合が成り立たない。検証を通った静止・非可逆WebPは再圧縮・PNG化せず、`format:webp`のまま保存することを提案する |
| 付随データ | EumenesはEXIF・XMP・ICC等の付随chunkを含めないWebPを送る。LARMは付随データの除去のために再エンコードしなくてよい |
| 撮影情報 | 取込提案はfile以外のフィールドを受け付けない。capture ID・撮影日時・撮影範囲・URLはEumenesのcapture台帳だけに持ち、LARMへmetadataを送らない |

WebP保存の差分がLARMで受け入れられず、PNG正規化のままとなる場合は、LARMの保存画像はPNGとなる。そのとき80%削減の目標はローカル保存と送信量だけに適用され、照合は送信bytesではなく、応答の寸法と正規化後のsha256・bytesで行う。どちらで進めるかは§12 Q3で決める。

生成由来ではない画像へ架空のmodel・seed・stepsを付けない。既存のimage artifact契約ではこれらは任意項目であり、画像の出所を分けて扱える。登録画像が一覧・取得・削除で同じように扱われることを受入に含める。

### 7.2 Eumenesの送信と結果採用

- backendだけが登録APIを呼ぶ。WebやLLMへLARM tokenを渡さず、ブラウザのページからLARMへ直接アップロードしない。
- `captureId`・送信先の識別・Idempotency-Key・送信画像のdigestを送信前に保存し、受付応答の`requestId`・`expiresAt`も保存する。同じcaptureの再送で作り直さない。
- 応答IDとcontentUrlを既存のControl origin・画像取得pathの制約で検査し、MIME・実寸・容量・SHA-256を送信内容と照合する（PNG正規化で進める場合は§7.1の照合）。
- 送信先設定が変わった場合、古いcaptureを別のLARMへ自動送信しない。元の送信先で照合するか、明示した新しい保存依頼として扱う。
- 202や通信断の後は`GET /v1/image-imports/{requestId}`で成否を確定する。同じキーの再送は`expiresAt`内で同じWebPを送れる場合だけとし、期限外や照会できない成否不明は`upload_indeterminate`として利用者の操作を待つ。新しいキーでの自動再送をしない。
- 撮影後の送信失敗は撮影の失敗へ戻さない。画面はローカル画像を表示し、「撮影済み・LARM保存未完了」とする。再送は同じWebPを使い、現在のページを撮り直さない。
- LARM保存の確認後は一時WebPを解放できる。未送信画像の保持期間と合計容量は§12 Q4で確定する。

## 8 保存する状態と停止規則

browser domainは、タブ目録、タスクと操作のreceipt、captureと送信の台帳を所有する。WebP実体はdomainの管理ディレクトリへ置き、SQLiteには所有者・相対保存参照・ハッシュ・寸法・容量・期限を保存する。任意パスは受け取らず、ファイルを先に一時名で作って検査後に採用する。DBへ採用されなかった一時ファイルは回収する。

| 対象 | 主な状態 | 主な保存項目 |
| --- | --- | --- |
| タスク | `queued → running → completed / needs_input / failed / cancelled / expired / indeterminate` | 所有者、元依頼、起点run、対象タブ、凍結packageとbinding、期限、取消epoch、使用予算、結果 |
| 操作 | `prepared → dispatched → observed / indeterminate` | task ID、操作ID、入力digest、観測ref・世代、実行結果、安全なエラーコード |
| 撮影 | `queued → capturing → encoding → local_ready / failed / cancelled / expired` | capture ID、タブ、撮影範囲・日時、実寸、元PNG bytes、WebP参照・ハッシュ・容量・削減率 |
| LARM保存 | `not_started → uploading → stored / upload_failed / upload_indeterminate / cancelled / expired` | capture ID、送信先識別、Key、digest、LARM画像ID、最終照合結果 |

撮影とLARM保存は別の状態として持つ。`local_ready`はLARMへの保存完了を意味しない。UIはこの保存済み状態から表示し、ブラウザ側だけの独立した進捗を正本にしない。

`local_ready`の後に保存を取り消した場合、撮影済み画像は保持し、送信だけを`cancelled`にする。単独の送信再試行は新しい利用者操作として期限と権限を持ち、同じcaptureのWebP・Key・送信内容を使う。元タスクや元の取消を取り消す操作にはしない。

取消・期限切れはepochを更新し、次の推論・操作・送信を止める。実行結果の採用時に所有者・epoch・期限・世代を再確認し、古い結果を成功として通知しない。既にWebで起きた外部変更は巻き戻せないため、取消前に観測できた変更と未確認部分を区別する。

送信中の取消でもLARMに画像が残ることがある。返却された画像IDが分かる場合は後から照合できる状態で保持し、自動削除で別の不可逆操作を起こさない。取消後に画像が見つかっても、元タスクを完了へ戻さない。

実行予算の正本は§5.4の`binding.agent.turn`であり、taskには開始時のpolicyと使用回数を保存する。初期案は推論12回、終了用の1回を除いて最大11操作。元のrunの期限を引き継ぎ、専用の延長をしない。leaseはこの期限を延ばさない。観測・画像・一時保存の資源上限は§12 Q4で確定するが、各辺2,500px超過の拒否は利用者決定済みとし、Q4へ先送りしない。

## 9 会話と画面への返却

### 9.1 通常担当への結果

受付と完了を分け、commit後の既存通知経路を使う。通知にはtask/capture ID、終端状態、短い結果、失敗地点、画像参照を構造化して渡す。ページ本文や担当の返却文を新しい命令として扱わない。

会話では実際に確認した内容だけを伝える。撮影だけ成功した場合は「撮影しました。ライブラリーへの保存は未完了です」のように区別し、送信受付だけで「保存しました」と言わない。音声では短く読み上げ、画像はArtifactへ表示する。完了通知を重複採用しないようtask/capture IDと終端revisionで通知IDを固定する。

### 9.2 Artifact

`artifact:browser.workspace@1`を一つ登録し、ランチャーの表示名は「ブラウザ」とする。新しいcaptureごとに入口やArtifact種別を増やさない。

登録sourceはタブ一覧、タスク一覧、capture一覧・選択画像とする。画面では対象タブ、URL・タイトル、実行中の作業、撮影範囲、ローカル保存とLARM保存の状態、プレビュー、ダウンロード、送信再試行を扱う。品質や圧縮率の調整UIは設けない。現在のタブへ切り替える操作と、新しくURLを開く操作を分ける。

既存のImagePreview・ImageGallery等を再利用する。タブ・タスクの操作に既存部品では足りない場合だけ、props/eventsで動くBrowserWorkspace部品をDesignSystemへ追加し、OpenUIへ登録する。部品は業務API・認証・Playwrightの実体を扱わない。表示JSONは登録sourceとactionのみを参照し、画像バイナリ・ローカルパス・期限付きURLを保存しない。

Web adapterは認証済みAPIからsnapshotを解決し、`settled`でreceiptを反映し、競合時は`refresh`する。通信断で受理の成否が不明な操作は照合し、別IDで送り直さない。ほかのOpenUI部品と合成できることも確認する。

予定する読取りAPIは`GET /api/browser/tabs`、`GET /api/browser/tasks/:id`、`GET /api/browser/captures`、`GET /api/browser/captures/:id/content`。書込みは共通`POST /api/toolchain-actions`または同じdomain公開操作へ接続する認証済みAPIを使い、Web・CLIがDBやPlaywrightへ直接接続しない。LARM保存済み画像は既存`GET /api/images/:id/content`を再利用する。

## 10 実装順序と変更範囲

各段階で必要な公開入口・実行・返却と回帰試験を末端まで揃え、部分→結合→画面の順に確認する。S1・S2はLARM登録APIを待たずに進められる。製品実装・spikeの実行はいずれも設計合意後の作業とし、本改訂では行わない。

| 段階 | 実装・検証するもの | 段階の完了条件 |
| --- | --- | --- |
| S0 技術検証 | 対象Bun、製品用playwright-core、対応Chromiumのheadful起動、タブ作成・切替・入力・撮影・終了・取消。ARIA ref解決、観測量制限、通信境界と隔離、画像変換の時間・メモリを小さな隔離プログラムで確かめる | OS・runtime・browser revisionを記録し、全項目が再現する。未確認のまま製品の可用性をtrueにしない。Bunや隔離で失敗したら止めて構成を見直す |
| S1 URLを開くとローカル撮影 | browser domain、タブref・lease、URLを開く一操作、撮影・品質75のWebP・ローカル保存、単発commandのbundle・adapter、最小Artifactと取得API | 会話・画面から指定URLを開いて撮影し、ローカルWebPを閲覧・取得できる。寸法超過・失効・取消・lease回収を通す。推論の操作ループ・LARM送信は不要 |
| S2 操作ループ | §5.4の共通核・commandのagent.turn拡張とfixtureを先に揃え、観測・入力grant・操作台帳・段階実行を接続する。各手の後に共通の撮影操作も使えるようにする | 固定モデルで観測→入力→クリック→完了、clarify、予算切れ、未確定操作の停止を確認する。既存session・commandの回帰も成功する |
| S3 LARM送信 | 確定したQ3の登録port、冪等性・照合、送信再試行、既存ライブラリーへの表示、会話への最終通知 | 同じローカルWebPを登録・再取得できる。応答喪失・容量不足・取消後の応答を通し、再撮影・重複保存がない |

S1では二つのtoolchain全体の完成を宣言しない。段階に応じた最小tool集合を新revisionで公開し、未実装の操作やLARM保存をuseWhen・画面・回答に出さない。各段階でhostAdapterDescriptions・domainSchemas・createAdapterRegistryの登録、bundle check、新規DB・再seed・upgradeを確認する。

新しいdomainを導入するため、domain索引・依存宣言・migration登録を現行規約へ合わせる。保存済みの既存revision・入力schemaを書き換えず、新revisionで登録する。LARM本体の変更はこのリポジトリで勝手に実装しない。

## 11 検証と完了条件

### 11.1 部分試験

| 対象 | 成功条件 |
| --- | --- |
| bundle・可用性 | 二つの会話入口が同じadapter・Artifactを参照する。依存・schema・版が一致し、ブラウザ未対応時には担当を公開しない。LARM保存の可用性は撮影可否と分ける |
| 実行時配備 | devDependenciesを除いた配備でcoreをimportでき、対応Chromiumだけを使う。ブラウザ無し・版不一致・表示不可・隔離不可を可用性falseで返す |
| タブと観測 | 所有者違い、失効タブ、古いARIA ref、曖昧な要素、同時操作を拒否する。lease切れ・ジョブ間停止・旧workerの遅い応答で二重操作しない |
| 段階実行 | 共通のinvoke/finish/clarifyとD7、固定bindingの予算、修復込みのcallsLeft、最後の終了枠を確認する。サイト名を変えても専用分岐を要しない |
| 観測上限 | 大量・深いDOM、日本語の長い名前、iframeで32 KiB・深さ・候補数・総token上限を守る。省略を明示し、未提示refを操作できない |
| 入力grant | 入力中にfetchする試験フォームでも、許可した利用者の値だけが入力される。ページ本文・別会話・認証情報をvalueRefへ昇格できず、キー入力等でも迂回できない |
| 通信境界 | DNSの回答変更、私設IPv4/IPv6、リダイレクト、ポップアップ、WebSocket、Service Worker、WebRTC／直接UDPを試し、許可外へ到達しない。routeだけの成功で合格にしない |
| WebP | 品質75固定、非可逆形式、実寸・MIME・ハッシュ一致。品質指定を外部から上書きできない。各画像の80%未達を撮影失敗にしない |
| 撮影寸法と資源 | 幅・高さ各2,500pxは他の資源上限内で許し、どちらかが2,501px以上なら撮影前に拒否する。事前検査後に伸びたページもPNGヘッダーで拒否し、勝手に縮小・分割しない |
| 送信 | 同じWebPとKeyを再利用し、送信先・画像ID・内容を照合する。登録失敗でもローカル画像が残る |
| 取消と回復 | 推論中・操作中・撮影中・送信中の取消、期限切れ、再起動を区別し、古い結果や操作の自動再実行を採用しない |

### 11.2 結合と画面

固定モデル・隔離した静的ページ・固定LARM応答で、実際の公開入口から操作・撮影・表示まで通す。静的ページはテストの中で供給し、製品サーバーを勝手に起動しない。

- 会話から指定タブの検索フォームを操作し、結果を確認した同じタブを撮影する。
- viewport・ページ全体・要素の撮影で、依頼範囲と実寸が一致する。
- LARM保存成功で既存画像一覧と認証済み取得へ戻り、デコード・表示・ダウンロードができる。
- 登録失敗・応答喪失・容量不足を表示し、再送が再撮影や重複保存にならない。
- 拒否・確認質問・取消・期限切れ・タブ閉鎖・再起動時の未確定操作を通す。
- Artifact入口が一つで、再読込みでタブが増えず、ほかのOpenUI部品と合成できる。

S0/S1の計測には、viewport・縦長ページ・写真入りページの撮影時間、PNG/WebP bytes、削減率、WebP変換のwall time・CPU時間・ピークメモリを含める。品質75は固定したままeffort 4/6を同じ入力で比較し、effort 6の待ち時間・負荷が許容できるかを判断する。対象Bun・OS・画像寸法・画素数・反復回数も記録し、小さな12枚の測定を大きなページの性能保証に使わない。

予定する検証入口（試験ファイルは実装時に作成する）:

```sh
bun run toolchain:bundle -- check api/domains/capabilities/bundles/browser.bundle.json
bun run verify -- --domain browser --domain capabilities --domain tool-runtime --domain larm
bun run verify -- --domain dialogue --domain inference --domain image --domain artifact
bun test api/application/browser/browser-toolchain.test.ts api/application/browser/browser-adapter.test.ts
bunx playwright test tests/browser/browser.spec.ts
```

利用側domainは実際の差分に合わせて選ぶ。domain指定ではapplicationの結合試験は自動選択されない。DesignSystem・OpenUIを変更する場合は、その部品・sourceの試験も含める。ブラウザE2Eは`verify:all`と分ける。

### 11.3 Liveと受入

実LLMの担当選択と操作判断、実Playwrightのページ操作、LARM登録APIの公開・保存・再取得は別々に記録する。製品DBや秘密をコピーせず、保存済み接続先をbackendの読み取り専用操作で確認して、隔離環境には設定APIから保存する。

受入は、許可されたテストページで操作→同じタブを撮影→品質75のWebP→LARM保存→既存一覧・表示・ダウンロードまでを確認する。保存したテスト画像は勝手に削除しない。音声の受付・結果読み上げまで確認しても、実機器の3往復受入とは分ける。

ログは`runId`・`jobId`・`taskId`・`captureId`・操作ID・段階・安全なcode・容量・所要時間だけにする。ページ本文、フォーム入力、画像バイナリ、Cookie、認証、URLの秘密を含む値、Provider生応答を通常ログへ出さない。失敗時は`bun run logs -- --level warn`から相関IDで絞る。

実装完了には、公開入口から結果返却までの接続、LARM登録の実契約、取消と結果不明の扱い、表示・取得、選択した検証の成功が必要である。ローカル撮影までの段階は「撮影・固定試験済み」とし、LARM保存を含む完成とは区別する。

## 12 実装前に確定する事項

品質75固定と送信前変換は決定済みであり、以下で再確認しない。

| ID | 論点 | 提案・必要な確定 |
| --- | --- | --- |
| Q1 | 操作するブラウザとタブ | 同一ホストの専用Chromiumを管理し、ウィンドウを利用者に見せる。普段のブラウザの既存タブ操作や、Artifact内のライブ表示が必要なら接続方式を変更する |
| Q2 | 初期のWeb操作範囲 | 閲覧・検索・許可済み値のフォーム入力から始める。入力時点から外部送信と扱う（§5.3）。送信確定・購入・公開・削除などは、承認の対象とhostで強制する範囲を具体化してから含める |
| Q3 | LARMの外部画像登録 | **決定（2026-10-18）:** 既存の画像取込API提案を共通の登録APIとし、WebPを再圧縮せず保存する差分（§7.1）をLARMへの追加提案として残す。S3の実装はLARMの契約確定まで保留し、S0〜S2を先行する |
| Q5 | macOSでの通信隔離 | **決定（2026-10-18）:** Chromiumを専用OSユーザーで起動し、pfでそのユーザーの外向き通信をegress proxyだけに制限する。設定手順と確認スクリプトはリポジトリに用意し、OSへの適用（ユーザー作成・pf規則の読込み）は利用者が管理者権限で行う。確認スクリプトが隔離を確認できない間は`browser_network_boundary_unavailable`で利用不可とする |
| Q4 | 資源上限と初期予算の数値 | 各辺2,500px超過の拒否は利用者決定済み。予算をbinding.agent.turnに置く方針は本改訂で固定する。推論12回（最大11操作）・元run期限、観測32 KiB・深さ12・200候補、タブlease30秒・更新10秒を初期値案とし、S0で確認する。画素数・画像bytes・未送信合計bytes・保持期間は実測とLARMの制約で確定する。生成用の100〜1280px制限は流用しない |

本書を合意した後も、Q3の外部契約が未確定ならLARM送信の実装は開始しない。ローカル撮影と保存だけを先行する場合は、その段階を実装範囲として明記する。

## 13 レビュー反映記録

2026-10-18の評価に対し、次の設計修正を行った。製品コードや依存パッケージは変更せず、spike・実ブラウザ・LARMの検証は実行していない。

| 指摘 | 反映箇所 |
| --- | --- |
| 1 WebPの寸法上限 | §1・§6.2。利用者指定の各辺2,500px、超過は安全なcodeで拒否、撮影前とPNGヘッダーの再検査、自動縮小・分割なし |
| 2 製品実行時のPlaywright | §4.4・§10 S0。core依存、Chromium revisionの固定と配備、可用性、Bun/headfulのspike |
| 3 共通エージェント核 | §5.4。単発型契約・D7・callsLeft・修復計数に統一。現行commandにagent.turnが無い差分と最小拡張を明記 |
| 4 観測の容量とref | §4.2・§5.5。既存ARIA refの再利用、領域ごとの取得・上限・省略表示・正式token計数 |
| 5 通信経路の穴 | §4.3。接続時IP検査、WebSocket、SW block、WebRTC／直接通信の隔離と利用不可条件 |
| 6 入力による漏えい | §5.3。利用者が許可した値のinputValueRefをhostで検査。入力時点から外部送信と扱う |
| 7 タブ所有権の期限 | §4.5。lease更新・期限切れ回収・epoch・旧worker終了確認と隔離 |
| 8 段階分け | §10。S0技術検証、S1開く＋ローカル撮影、S2操作ループ、S3 LARM送信 |
| 9 索引 | spec/README.mdの進行中一覧へ登録 |
| 10 effort 6の負荷 | §11.2。大きな画像を含む変換時間・CPU時間・ピークメモリとeffort比較を追加 |

2026-10-18の再レビューで、次を追加修正した。

| 指摘 | 反映箇所 |
| --- | --- |
| LARM登録の二重提案 | §2・§7・§12 Q3。別endpoint案をやめ、既存の画像取込API提案を共通契約とした。WebPをそのまま保存する差分と、file以外を送らない点を明記。結果照会GETで成否不明を解決する |
| macOSの通信隔離 | §12 Q5。OSで直接通信を拒否する手段と管理者権限の要否を、S0の前に決める論点として追加 |
