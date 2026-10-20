# ブラウザのタブ操作ツールチェーン設計

作成日: 2026-10-18

状態: 合意済み（2026-10-18）。S0〜S2を実装中。利用者の普段のBrave（プロファイル・ログイン状態をそのまま使う）を、Playwright MCP Bridge拡張機能とbackendの子プロセス`@playwright/mcp`で操作・撮影する。専用Chromiumを管理する旧案（[archive](.archived/playwright-toolchain-design-2026-10-18.md)）を置き換える。製品実装は未着手。単発型の共通核（§5.4）は実装・固定試験済み。

関連: [登録と拡張の手順](../docs/toolchain-extension.md)、[検証手順](../docs/toolchain-extension-verification.md)、[サブエージェントの二つの型](subagent-task-and-session-agents-design-2026-10-18.md)、[LARM](../docs/larm.md)、[画像ライブラリー](../docs/images.md)、[LARM画像取込API提案](reference/larm-image-import-v1-proposal/README.txt)。

追補（2026-10-20）: [実行Script・進捗を主体とするUIと接続承認省略の設計案](browser-script-progress-ui-design-2026-10-20.md)。入力のチャット統一、設定アーティファクトへの移設、§12 Q1の承認省略を具体化する。追補は未実装・実機未検証であり、本書の現行実装・検証状況を置き換えない。

## 1 目的と決定事項

Eumenesを開いている利用者のBraveで、Eumenes自身のタブ、Eumenesが開いたタブ、Eumenes上のリンクから開いたタブを、会話から操作・撮影できるようにする。撮影した画像は非可逆WebPで保存し、表示・取得できるようにする。

| 責務 | 入力 | 完了条件 |
| --- | --- | --- |
| ページ操作 | 利用者の依頼、対象タブ、必要なら開くURL | 実際のページを観測しながら操作し、実行結果または停止地点を通常担当へ返す |
| 画像キャプチャー | 対象タブ、撮影範囲 | 指定範囲を撮影し、品質75固定の非可逆WebPでローカル保存する。LARM保存はS3 |

利用者と決めた事項（2026-10-18）:

- 操作するのは**利用者が普段使うBraveのプロファイル**であり、新しいブラウザやプロファイルを起動しない。起動し直したブラウザではログイン状態を引き継げないため、意味がない。
- 接続はブラウザ拡張機能で行う。既製の**Playwright MCP Bridge**（Chrome Web Store、拡張ID `mmlmfjhmonkocbjadbfplnigmagldckm`）を使い、拡張機能を自作しない。
- Eumenes自身のタブも操作対象にする。Eumenesが開いたタブ、Eumenesのリンクから開いたタブも同様に対象にする。
- 画像は品質75固定の非可逆WebP。各辺2,500px超過は`capture_dimensions_exceeded`で拒否し、自動縮小・分割をしない。
- 依頼文から抽出・整形した入力値は許可済みとして扱う（§5.3）。
- LARMへの送信（S3）は、既存の画像取込API提案を共通契約とし、WebPを再圧縮せず保存する差分の確定まで保留する。

本書の対象外は、拡張機能の自作、専用ブラウザ・プロファイルの起動、動画録画、任意スクリプトの実行、Cookie・保存データの読取り、ダウンロード・ファイル選択・権限の自動許可、画像生成・編集、OCRや3D生成の自動起動とする。

## 2 実機確認（2026-10-18）

Brave 1.97.59（Chromium 155）、Playwright MCP Bridge（ストア版）、`@playwright/mcp@0.0.83`（同梱playwright-core 1.64.0-alpha）を、stdioのMCPクライアントから確かめた。確認スクリプトはスクラッチ領域に置き、製品コードではない。

| 確認 | 結果 |
| --- | --- |
| 普段のBraveで接続 | 成功。`PLAYWRIGHT_MCP_EXECUTABLE_PATH`にBraveの実行ファイルを指定すると、起動中のBraveで接続ページが開き、利用者が選んだタブへ接続した |
| スナップショット | 成功。`[ref=e4]`形式の要素ref付き。Eumenesのページで約9KB |
| 撮影 | 成功。PNG 1500×685（viewport） |
| 接続時に見えるタブ | 選んだタブだけ。接続前から開いていた他のタブは見えない |
| MCPから開いたタブ | 一覧に加わり、操作できた |
| 接続中のタブから開いたタブ | `window.open`で開いたタブが自動で一覧に加わり、スナップショットを取れた（リンククリックで開くタブの代わり） |
| 書出し | MCPは作業ディレクトリへ`.playwright-mcp/`を作り、コンソールログ・スナップショットをファイルに書いた |

仕組み: `@playwright/mcp --extension`はloopbackにCDP中継のWebSocketを開き、ブラウザの実行ファイルに`chrome-extension://…/connect.html?mcpRelayUrl=…`を渡して開かせる。Bridgeは利用者が選んだタブに`chrome.debugger`で接続し、中継を通してPlaywrightの`connectOverCDP`がそのタブを操作する。中継はplaywright-core内部の非公開実装であり、Eumenesは直接使わない。

## 3 全体構成

```text
会話 → browser_operate / browser_capture → command担当 → adapter:browser@1
  → browser domainの公開transaction操作（受付・receipt・queue）
  → queueの実行段階 → BrowserDriver port
      → application: MCPクライアント → 子プロセス @playwright/mcp --extension（stdio）
      → Bridge拡張機能 → 利用者のBraveのタブ
  → 撮影PNG → sharpで品質75 WebP → ローカル保存
  → 結果をbrowser domainへ保存 → commit後に会話通知・画面更新
画面 → 共通toolchain-actions → 同じadapterとdomain
```

| 所有するもの | 置き場所 |
| --- | --- |
| 接続・タブ目録、タスク、操作・撮影の台帳、状態遷移、HTTP API | `api/domains/browser/` |
| `BrowserDriver`等のport | `api/domains/browser/contracts/ports.ts` |
| MCP子プロセスの起動・停止、MCPクライアント、ツール呼出しの許可リスト、出力の解釈 | `api/domains/browser/adapters/` |
| WebP変換・ファイル保存 | `api/domains/browser/adapters/` |
| domain間の接続と登録adapter | `api/application/browser/` |
| 担当・ツール・binding・Artifact | `api/domains/capabilities/bundles/browser.bundle.json` |
| 画面部品 | `packages/design-system/src/components/BrowserWorkspace/`（作成済み）、OpenUI登録、`web/src/domains/browser/` |

browser domainはLARM・dialogueのrepositoryへ直接アクセスしない。推論・完了通知はportとしてapplicationから注入する。MCP・ブラウザとの通信をwriter transactionへ入れない。

## 4 ブラウザへの接続

### 4.1 依存と設定

- `@playwright/mcp`を固定版でdependenciesへ追加し、backendはインストール済みのパッケージを子プロセスで起動する。実行時に`npx`で取得しない。同梱のplaywright-coreの版は`@playwright/mcp`に従い、Eumenesの`@playwright/test`（E2E用）とは独立に扱う。旧案で追加した`playwright-core`の直接依存は削除する。
- Braveの実行ファイルのパスはSQLiteの設定として保存し、設定APIから登録する。環境変数を要求しない。未設定の間は`browser_not_configured`で利用不可とする。**（2026-10-20 利用者決定）** 未設定の間だけ、backendはOS標準のインストール先（macOSは`/Applications`と`~/Applications`のBrave、Linuxは`/usr/bin/brave-browser`等）に実行可能なファイルがあれば`GET /api/browser/setting`の`suggestedPath`で返し、画面は入力欄に入れて提案する。保存されるまで使わず、利用不可の扱いは変えない。**（2026-10-20 利用者決定）** macOSでは設定の「参照…」で、backendが`osascript`の`choose file`（OS標準のファイル選択）を開く（`POST /api/browser/setting/browse`、同時に一つ、5分で閉じる）。`.app`を選ぶと`Info.plist`の`CFBundleExecutable`から実行ファイルのパスに直し、実行可能なファイルか確かめて入力欄へ返す。保存は「保存」で行う。ダイアログはbackendと同じコンピュータの画面に出る。macOS以外は`canBrowse:false`で「参照…」を出さない。画面の操作は`artifact:browser.workspace@3`の`browse-path`（local）。
- 子プロセスへ渡す環境変数は`PATH`・`HOME`・`PLAYWRIGHT_MCP_EXECUTABLE_PATH`だけとする。backendのtoken・LARM設定・その他の環境変数を渡さない。
- MCPの出力ディレクトリ（`--output-dir`等）はbrowser domainの管理ディレクトリ配下の一時領域に固定する。書き出されたスナップショット・コンソールログはページ本文を含むため、読んだ後に削除し、リポジトリ・通常ログへ残さない。
- Bridge拡張機能の導入は利用者が行う。導入手順と、Braveでストア版を入れられることを`docs/`に記載する。

### 4.2 接続のライフサイクル

1. 利用者が画面または会話で「ブラウザに接続」を指示する。backendはMCP子プロセスを起動し、接続を始める。
2. Braveに接続ページが開く。利用者はタブを選び、接続を許可する。通常はEumenesのタブを選ぶ。
3. 接続後は、選んだタブ、そのタブや接続中のタブから開いたタブ、MCPで開いたタブを操作できる。接続前から開いていた他のタブは見えないため、操作したい既存タブがあれば利用者がそのタブで接続し直す。
4. 接続は、利用者の切断、Braveの終了、子プロセスの終了、backendの停止で終わる。終わったら全タブrefを失効させ、実行中の操作は`indeterminate`とする。自動で接続し直さない。

接続ごとに承認する方式を既定とする。拡張機能のtoken（`PLAYWRIGHT_MCP_EXTENSION_TOKEN`）で承認を省く方式は、どのタブへ接続されるかを確認してから採否を決める（§12 Q1）。採用する場合、tokenはSQLiteへ保存し、ログ・画面・LLMへ出さない。

接続の待ちには期限を設ける。期限内に接続されなければ`browser_connect_timeout`として子プロセスを止め、画面へ再試行を示す。

### 4.3 タブの参照

- hostが`tabRef`を発行し、MCPのタブ番号・URL・タイトルと対応付けて保存する。MCPのタブ番号はタブを閉じると詰まるため、番号だけでタブを指さない。
- 各操作の直前にタブ一覧を取り直し、保存した対応と照合する。一致しなければ`tab_lost`として止め、似たURLのタブへ置き換えない。
- MCPのセッションは「現在のタブ」を一つ持ち、操作はそのタブに対して行われる。hostはタブの選択と操作を一つの直列区間で行い、接続全体で同時に一つの操作だけを実行する。タスクごとのタブ所有（lease）は旧案§4.5の規則を維持し、別タスクのタブは`tab_busy`とする。
- 観測ごとに`observationRef`と世代を発行し、要素refを`observationRef`・タブ・世代と組にして検査する。遷移後は古いrefを失効させる。

### 4.4 安全境界

普段のプロファイルにはログイン状態があるため、旧案より誤操作の影響が大きい。

- LLMが使える操作は、hostの許可リストに載せたMCPツールだけとする（§5.2）。`browser_evaluate`・`browser_run_code_unsafe`・`browser_file_upload`・`browser_network_*`・`browser_console_messages`・ドラッグ系はLLMへ公開しない。hostが寸法測定に使う固定関数だけ、`browser_evaluate`をhost内部から呼ぶ（§6.2）。
- 遷移先はhttp/httpsだけとする。`chrome:`・`brave:`・`chrome-extension:`・`file:`・`javascript:`・`data:`を拒否する。
- loopback・私設アドレスへの遷移は、EumenesのWeb画面のページだけを許可し、`/api/`配下を拒否する。Viteの開発proxyは同一originの要求にAPI認証を付けるため、APIのURLへ遷移させると認証付きの応答がページとして表示されるからである。
- Eumenesのタブの操作は、利用者がEumenesの画面で行う操作と同じ権限を持つ。外部ページの本文に誘導された操作でEumenesの設定・データを変えないよう、Eumenesの画面での保存・削除・送信は§5.3の確定操作として扱う。
- Cookie・localStorage・保存パスワード等を読み取る手段を公開しない。ページ本文は取得資料として囲み、指示として扱わない。

## 5 ページ操作タスク

### 5.1 登録と受付

入口は`toolchain:browser.operate@1`、会話関数`browser_operate`、`package:browser.operate@1`、`binding:browser.operate@1`（`execution:"command"`）。command担当へ公開する操作は`browser.task.start`・`browser.task.status`・`browser.task.cancel`・`browser.workspace.open`・`browser.connect`。開始入力は平坦objectで、`request`と任意の`tabRef`・`url`。

| 登録 | ページ操作 | 画像キャプチャー |
| --- | --- | --- |
| useWhen | 開いているタブ・Eumenesの画面を読み取って操作する、URLを開く | 今のタブ・ページ全体・指定要素を画像として保存する |
| examples | 「このタブで商品名を検索して」「さっき開いたページの次の項目を開いて」「この画面の設定を開いて」 | 「今のタブを撮って」「ページ全体を画像にして」「この図だけキャプチャーして」 |
| redirects | 公開情報の検索・本文取得だけで足りる依頼は既存Web調査へ | 新しい絵や写真を作る依頼は画像生成へ |
| 結果契約 | `domain:browser.receipt@1`・`projection:browser.task-result@1` | 同じreceipt・`projection:browser.capture-result@1` |

可用性`availability:browser@1`は、設定済み・依存あり・接続中のときだけtrueとする。未接続のときは担当が「ブラウザに接続してください」と案内し、接続操作へつなぐ。受付のreceiptは`taskId`と`accepted`を返し、最終結果は後続の通知で伝える。

### 5.2 観測と次の一手

受付後は実行package `package:browser.page-operator@1`のprofile・SKILL・ツール契約を凍結し、1ジョブ1推論の段階実行で進める。

1. hostがMCPの`browser_snapshot`で対象タブを観測し、URL・タイトル・要素ref付きスナップショット・残り予算を得る。
2. 単発型の共通核（§5.4）で推論し、LLMが`invoke`（ツール一つ）・`finish`・`clarify`を返す。
3. hostが引数・対象・権限・世代を検査し、操作を台帳へ保存する。
4. transaction外でMCPのツールを呼び、結果を照合して保存する。次の観測が必要なら新しいジョブを積む。

| LLMへ公開する操作 | 使うMCPツール |
| --- | --- |
| タブ一覧・選択・新規・閉じる | `browser_tabs`（list・select・new・close） |
| 遷移・戻る | `browser_navigate`・`browser_navigate_back` |
| 観測 | `browser_snapshot` |
| クリック・ホバー | `browser_click`・`browser_hover`（観測済みref） |
| 文字入力・フォーム | `browser_type`・`browser_fill_form`（§5.3の入力grant） |
| 選択・キー入力 | `browser_select_option`・`browser_press_key` |
| 待機 | `browser_wait_for`（契約で制限した条件・時間） |
| 撮影 | §6の共通撮影操作 |

ページの意味理解、操作順、結果の解釈はLLMへ委ねる。hostは要素名の辞書、サイト別手順、発話の正規表現、固定クリック列を持たない。

MCPの応答は、スナップショットをインラインで返す場合と、出力ディレクトリのファイルへのリンクで返す場合がある（実機で両方を確認）。adapterは両方を解釈し、ファイルは読んだ後に削除する。応答の形式はMCPの版に依存するため、版を固定し、解釈の試験を版の更新時に通す。

### 5.3 権限と不明な結果

送信・購入・公開・削除、Eumenesの画面での保存・削除・送信などの確定操作は、現在の依頼で許可された範囲だけ実行する。初期版に含める確定操作の範囲は§12 Q2で決める。承認は対象タブ・操作内容・世代に結び付け、内容が変わった操作へ流用しない。

**確定操作のhost判定（2026-10-19 利用者決定）:** LLMの`effect`申告は信頼境界ではない。hostはクリック・キー入力・submit付き入力の直前に、固定関数で対象要素（キー入力は現在のフォーカス要素）のHTML上の意味を調べる。要素がGET以外（POST・`dialog`以外の明示method等）のフォームを送信する場合、またはLLMが`effect:"commit"`と申告した場合は、利用者の承認を要する。GETフォーム（検索）・リンク・フォーム外の通常ボタンは承認なしで実行する。ボタン名・サイト別の辞書は持たない。JavaScriptだけで送信するボタンは検出できないため、自己申告を併用する。承認待ちの操作はtaskを`needs_input`で止め、何をするかを利用者へ示す。利用者が同意したかは通常担当（LLM）が判断し、`browser.task.start`（`tool:browser.task.start@2`。入力schemaを変えるため操作IDは`browser.task.begin`）の`continueFrom`・`approvePending`で続きのtaskに承認を渡す。承認は対象タブ・URL・操作の種類・要素・入力値のdigestに結び付け、10分で失効し、一度使えば消費する。

フォームへの入力も外部への情報送信として扱う。hostは入力に使ってよい値に`inputValueRef`を発行し、task・origin・用途・期限へ結び付ける。現在の依頼文から抽出・整形した値は許可済みとする（2026-10-18 利用者決定）。LLMは値ごとに依頼文中の出所を示す。ページ本文・観測結果・別の会話・backend設定・Cookie・認証情報に由来する値には権限を付けず、出所を示せない値は利用者へ示して許可を得る。

外部Web操作にexactly-onceは保証できない。操作IDと入力digestを実行前に保存し、`prepared → dispatched → observed`を記録する。実行済みかもしれない状態で止まったら`indeterminate`とし、同じクリックや送信を自動で繰り返さない。

### 5.4 単発型エージェント核

`api/domains/inference/contracts/agent-task.ts`の共通核（実装・固定試験済み、2026-10-18）を使う。出力は平坦objectの`action: invoke / finish / clarify`、文脈はD7の並び、予算は固定したbindingの`agent.turn`（`maxModelCalls:12`、`retries.default:1`）。`callsLeft`を毎回提示し、修復・拒否後の推論も上限に数え、最後の1回はfinish/clarify用に残す。状態はJSONとしてジョブ間で保存する。

残りの接続作業: `api/application/toolchain/toolchain-routing.ts`でbindingの`agent.turn`を`BoundCommandSet.agentTurn`へ渡す。共通規則・REFERENCEの説明・修正指示の文は、browser側の`*.context.toml`で用意する。

### 5.5 観測量

MCPの`browser_snapshot`はページ全体のスナップショットを返すため、取得量をMCP側で絞れない。hostは取得後、LLMへ渡す前に、完全なノード単位で上限（初期案32 KiB・深さ12・操作候補200件）まで切り詰め、`truncated`と省略理由を添える。提示しなかった要素refは操作できない。推論の直前に正式なtoken計数で総量を検査し、収まらなければ`observation_budget_exceeded`で止める。

**古い観測の畳込み（2026-10-19 利用者決定）:** 新しい観測を渡すとき、それより前のTOOL_RESULTに含まれる観測本文を「URL・タイトル・失効済み」の一行に置き換える。古い観測の要素refは失効しており、本文を残す価値がないためである。単発型の共通核の「先頭を変えず追記する」原則は、ブラウザの観測本文に限って緩め、推論キャッシュが効く範囲が短くなることを受け入れる。取得したスナップショット全体はメモリ上でのみ扱い、保存しない。

## 6 画像キャプチャー

### 6.1 登録と入力

入口は`toolchain:browser.capture@1`、会話関数`browser_capture`、`package:browser.capture@1`、`binding:browser.capture@1`（`execution:"command"`）。二つのtoolchainは同じ`adapter:browser@1`と`artifact:browser.workspace@1`を使う。公開操作は`browser.capture.start`・`browser.capture.status`・`browser.capture.cancel`。入力は`tabRef`、`range`（`viewport`・`full-page`・`element`）、`element`のときだけ必須の`elementRef`。品質・形式・ファイルパス・URLは入力に持たせない。

ページ操作タスクからの撮影も同じcapture受付・queueを使い、画像変換を二重実装しない。

### 6.2 撮影と変換

```text
直列区間でタブを選択 → hostの固定関数で予定寸法を測定 → 2,500px検査
  → browser_take_screenshot（PNG、fullPage・要素ref）→ PNGヘッダーで実寸を再検査
  → sharpで品質75 WebPへ一回だけ変換 → 一時名で保存・検査 → 採用
```

| 項目 | 値・規則 |
| --- | --- |
| 形式・圧縮 | WebP、`quality:75`、`lossless:false`、`nearLossless:false`、`effort:6`（初期案）、付随データなし |
| 各辺の上限 | 1〜2,500px。超過は撮影前に`capture_dimensions_exceeded`で拒否する。撮影後もPNGヘッダーで再検査する |
| 予定寸法の測定 | hostの固定関数を`browser_evaluate`で実行し、viewport・文書・要素の寸法だけを読む。関数はコードに固定し、LLMの入力を含めない |
| 画素密度 | CSSピクセル等倍を目標とする。MCPの撮影の倍率を実装時に確認し、倍率が違えば寸法の検査をその実寸に合わせる |
| PNG | メモリ上の中間データのみ。MCPが出力ディレクトリへ書いたファイルは読んだ後に削除する |
| 保存名 | capture IDから作る。ページタイトル・URLを使わない |
| 検査 | デコード、実寸、MIME、非可逆形式、容量、SHA-256 |

撮影の前後で遷移世代が変わったら採用しない。旧案§6.3の容量実測（品質75で合計86.03%削減）を引き継ぐ。

## 7 LARMへの保存（S3、保留）

旧案§7の結論を引き継ぐ。既存の[画像取込API提案](reference/larm-image-import-v1-proposal/README.txt)（`POST /v1/image-artifacts/imports`、Idempotency-Key、結果照会GET）を共通の登録APIとし、検証済みの非可逆WebPを再圧縮せず`format:webp`のまま保存する差分をLARMへの追加提案とする。capture情報はEumenesの台帳だけに持ち、LARMへmetadataを送らない。LARMの契約が確定するまでS3を実装しない。

## 8 保存する状態と停止規則

| 対象 | 主な状態 | 主な保存項目 |
| --- | --- | --- |
| 接続 | `disconnected → connecting → connected → disconnected / failed` | 接続ID、開始・終了時刻、終了理由、子プロセスの識別 |
| タブ | `open → lost / closed` | tabRef、接続ID、MCPのタブ番号・URL・タイトル、世代、所有タスク・lease |
| タスク | `queued → running → completed / needs_input / failed / cancelled / expired / indeterminate` | 所有者、元依頼、起点run、対象タブ、凍結package・binding、期限、取消epoch、共通核の状態、結果 |
| 操作 | `prepared → dispatched → observed / indeterminate` | task ID、操作ID、MCPツール名、入力digest、観測ref・世代、結果、安全なエラーコード |
| 入力grant | 発行・使用・失効 | task、origin、用途、出所（依頼文・利用者承認）、期限 |
| 撮影 | `queued → capturing → encoding → local_ready / failed / cancelled / expired` | capture ID、タブ、範囲・日時、実寸、PNG bytes、WebP参照・ハッシュ・容量・削減率 |

LARM保存の台帳はS3で追加する。取消・期限切れはepochを更新し、次の推論・操作・撮影を止める。採用時に所有者・epoch・期限・世代を再確認し、古い結果を成功として通知しない。backend再起動時は接続を`disconnected`とし、全タブrefを失効させ、実行中の操作を`indeterminate`とする。

## 9 会話と画面への返却

受付と完了を分け、commit後の既存通知経路で結果を伝える。会話では確認した内容だけを伝え、音声では短く読み上げ、画像はArtifactへ表示する。

`artifact:browser.workspace@1`（ランチャー名「ブラウザ」）は、作成済みの`BrowserWorkspace`部品を使う。接続状態と「ブラウザに接続」「切断」、タブ一覧（切替・閉じる・新しくURLを開く）、タスク一覧、capture一覧・プレビュー・ダウンロードを扱う。利用不可の理由に`browser_not_configured`・`browser_disconnected`・`browser_connect_timeout`・`browser_mcp_unavailable`を加える。旧案のChromium・隔離用の理由コードは削除する。

読取りAPIは`GET /api/browser/connection`、`GET /api/browser/tabs`、`GET /api/browser/tasks/:id`、`GET /api/browser/captures`、`GET /api/browser/captures/:id/content`。書込みは共通`POST /api/toolchain-actions`を使う。Braveの実行ファイルのパスは設定画面から保存する。

## 10 実装順序

| 段階 | 実装・検証するもの | 段階の完了条件 |
| --- | --- | --- |
| S0 残りの確認 | Bunから固定版`@playwright/mcp`を起動・停止できること、`--output-dir`、tokenで承認を省いたときの接続先、撮影の倍率・fullPage・要素撮影、タブ番号の変化と照合、Braveの終了・タブを閉じたときの検出 | 結果を`verification-reports/`へ記録する。tokenの採否をQ1で決める |
| S1 接続とローカル撮影 | 設定、MCP子プロセスとクライアント、接続のライフサイクル、タブ目録・照合、撮影・WebP・ローカル保存、command登録、Artifact、取得API | 画面・会話から接続し、選んだタブとそこから開いたタブを撮影してWebPを閲覧・取得できる。寸法超過・タブ消失・切断・取消を通す |
| S2 操作ループ | 観測・切詰め、入力grant、操作台帳、共通核での段階実行、確定操作の承認 | 固定モデルで観測→入力→クリック→完了、clarify、予算切れ、未確定操作の停止を確認する |
| S3 LARM送信 | §7（保留） | LARMの契約確定後 |

各段階でbundle check、登録adapter・schemaの登録、新規DB・再seed・upgradeを確認する。新しいdomainの索引・依存宣言・migration登録を現行規約へ合わせる。

## 11 検証

- 部分試験: MCPの応答（インライン・ファイル）の解釈、許可リスト外のツールを呼べないこと、遷移先の検査（scheme・loopback・`/api/`）、タブ照合と`tab_lost`、直列区間、2,500/2,501px（幅・高さ）、WebP品質75・非可逆・付随データなし、取消・再起動・`indeterminate`、入力grant。
- 結合試験: MCP子プロセスは固定応答を返す試験用の差替えで代用し、公開入口から撮影・表示まで通す。製品サーバーを起動しない。
- 実機受入: 利用者のBraveとBridgeで、接続→Eumenesのタブの撮影→Eumenesのリンクから開いたタブの操作と撮影、までを記録する。実LLMの操作判断は別に記録する。音声の3往復受入とは分ける。

```sh
bun run toolchain:bundle -- check api/domains/capabilities/bundles/browser.bundle.json
bun run verify -- --domain browser --domain capabilities --domain tool-runtime --domain inference
bun run verify -- --domain dialogue --domain artifact
```

ログは`runId`・`jobId`・`taskId`・`captureId`・操作ID・MCPツール名・段階・安全なcode・容量・所要時間だけとし、ページ本文・スナップショット・入力値・画像・URLの秘密を含む値・tokenを出さない。

## 12 実装前に確定する事項

| ID | 論点 | 提案 |
| --- | --- | --- |
| Q1 | 接続の承認 | 接続ごとにBraveでタブを選んで承認する方式を既定とする。tokenで承認を省くと、どのタブへ接続されるかをS0で確かめてから採否を決める |
| Q2 | 初期の確定操作 | 閲覧・検索・許可済み値のフォーム入力から始める。送信確定・購入・公開・削除、Eumenesの画面での保存・削除は、承認の対象とhostで強制する範囲を具体化してから含める |
| Q3 | LARM保存 | 決定済み（S3保留、§7） |
| Q4 | 上限値 | 推論12回、観測32 KiB・深さ12・200候補、接続待ちの期限を初期案とし、S0・S1の実測で確定する |

## 13 旧案からの変更

| 旧案 | 本書 |
| --- | --- |
| backendが専用Chromiumを起動・管理 | 利用者の普段のBraveをBridge経由で操作。新しいブラウザ・プロファイルを起動しない |
| `playwright-core`を直接依存 | 固定版`@playwright/mcp`を子プロセスで使う。中継の内部実装は使わない |
| egress proxy・専用OSユーザー・pfによる通信隔離 | 削除。利用者の普段の通信環境で動く。代わりに操作の許可リストと遷移先の検査を強める |
| ARIA snapshotの領域ごとの取得 | MCPのスナップショット全体を取得し、LLMへ渡す前に切り詰める |
| 撮影前の寸法測定（Playwright API） | hostの固定関数を`browser_evaluate`で実行して測定 |
| タブ参照はPlaywrightのPage | MCPのタブ番号＋URL・タイトルの照合 |
