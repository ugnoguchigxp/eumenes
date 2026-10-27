# Eumenes

Eumenesは、**ユーザーを継続的に理解し、任された仕事を進め、状況に合うタイミングと方法で関わる専属の常駐アシスタント**を目指すプロジェクトです。SAAAの製品目的と設計方針を継承し、**限りなくAGIに近い専属アシスタントを、実際に使えるシステムとして実装すること**を到達点にしています。

価値の中心は、背景を説明し直すこと、細かな手順を指示すること、進捗を追い続けることの負担を減らすことです。継続的な理解、長期記憶、状況と世界の理解、目的に沿った判断と行動、継続仕事、能力の拡張、自己改善を一つのシステムにつなげます。これは目指す到達点であり、現在の実装がAGIやその体験全体を達成したという主張ではありません。

## 目指す体験と全体像

数日後の「この前の続き」から、関連する目標、判断理由、未解決事項を取り出し、話と仕事を引き継ぐ。好みや制約を覚えながら、「今回は違う」「方針を変えた」という訂正を受け入れる。候補が複数あれば確認し、推測を過去の事実として語らない。この体験を、会話と長期記憶、必要なときの深い想起、本人の状況や目標を扱うPersonal Worldで支えます。Personal Worldには因果・影響、条件、相関、依存、根拠と不確かさを含めます。

任された仕事は、離席や接続断、再起動をまたいで、実施済み操作と未完了部分を区別して進める。外部の担当への委任も含め、完了報告と妨げになっている条件への対応まで追跡する。そのための中核手段がツールチェーンです。能力の生成・検証・登録・発見・実行・UI/MCP連携・更新を実際の仕事へつなぎ、成果物と操作画面を会話と一緒に扱います。何を理解し、覚え、進めているかは俯瞰でき、利用者が訂正・停止・解除できる設計にします。

会議中、集中中、離席中では、仕事の進め方と通知の時刻・方法・まとめ方を変え、利用者の注意を尊重する。先回りは明示された目標や約束に結び付け、何もしない、今は着手しない判断も扱う。自律性は任された範囲を進めるために使い、観測や操作の許可範囲を保ちます。自己改善は、信頼できるテストと評価を経て、期限付き試験運用、本採用・棄却、切り戻しまでを扱う仕組みとして実現します。

**長期記憶、Personal World、ツールチェーン、ハーネスの自己改善は、必ず実現する中核機能です。** 実装は段階化し、成立条件と検証を積み上げます。初期段階の未実証や個別方式の失敗は方式を見直す材料とし、目指す機能そのものを廃止・大幅縮小する理由にはしません。

## 現在の実装と利用条件

以下は2026-10-27時点で、コード、spec、検証記録を読み取って確認した実装と利用条件です。上記の採用方針・到達点とは分け、実装済み、fixture（固定試験）検証済み、live（実接続）確認済み、実機器の受入済み、計画を区別しています。専属アシスタントとしての全体受入は未完了で、音声 MVP の実機器3往復も未受入です。

現在はTypeScript、Bun、Hono、React、SQLiteで構成し、ブラウザとCLIは共通のAPI・実行台帳を使います。推論は保存済みのLARM接続を基本とし、設定の用途ごとにクラウド接続も割り当てられます。会話エージェント（agency）と担当（サブエージェント）は会話用途の同じLLMを使い、機能ごとの専用LLM設定はありません。

| 機能 | 現在の実装と利用条件 |
| --- | --- |
| 会話・音声 | 会話エージェントは agency（`eumenes-agency`）だけで、返事・自分からの話しかけ・仕事の報告を行う（2026-10-25）。文字入力、発話単位のASR、回答の表示・読み上げ、ミュート、再生中の割込み、直前の発言の「止めて編集」。会話・実行状態をSQLiteに保存し、SSEで画面へ通知する。回答は生成の途中から句ごとにTTSへ流し、取消時は未再生分を捨てる。日英混在の回答は句・言語境界で日本語TTSと英語TTSへ振り分ける。発話検出はブラウザ内で動く学習済みモデルで行い、読み込めないときは音声入力を始めない。録音はAudioWorkletだけで、マイク・出力機器の喪失を表示する。いずれも実装・fixture検証済み。実LARMのTTS→ASR疎通はlive確認済み（2026-10-26）、実機器の3往復と発話検出の実録音は未受入。チャットへJPG・PNG・BMPを添付できる。音声には対応するASR・TTS接続とブラウザのマイク許可が必要。 |
| 会話の入力 | 先頭にSystemContext、中盤に長期記憶の趣向・傾向（300 token）と最近の会話の文、末尾に会話の状態（State）と今の入力を置く。ツールの行と調べた結果は次の回へ持ち越さず、SQLiteに残して担当で読む。背景の文脈係が、Stateの手入れ、関係する記憶・Worldの候補の注入、古い会話の区切りを行う（2026-10-27。実装・fixture検証済み。liveの測定・評価の再実行と実機器の受入は未実施）。 |
| ツールチェーン | ツール、専門担当、SystemContext、SKILL、Artifactを一組として、bundleと登録adapterのデータドリブン形式で登録する。全文検索・embedding・過去の選択から候補を提示する。依頼かどうかを分類する回は設けず、agency が返答の中で必要と判断したときに担当を検索・依頼する（予告・実行前の確認を含む）。仕事はサブエージェント（単発型・協働型）が進める。選択・実行結果は記録画面とCLIで照会できる。 |
| TODOと完了報告 | 担当の仕事はTODOとして進み、「TODOリスト」で進行中・完了未報告・報告済みを見られる。完了は agency が自発発話か返答で伝え、雑談の上限を消費しない。音声の再生が最後まで届いた（`heard: full`）ときだけアーカイブし、文字だけの表示・中断・音量0では確定しない（2026-10-27。実装・fixture検証済み。実LLMの判断品質と実機器での受入は未実施）。 |
| Web・会話履歴の調査 | Web確認の担当（guided）が検索と本文の取得を行い、回答文と根拠を返す。取得本文は未信頼としてガードを通す。指定サイト内の検索（妨げられたら外部検索で補う）、天気・株価の即答担当、Web取得の保存・キャッシュ、取得手順の再利用、会話履歴の検索を実装。調査も会話用途のLLMで行い、Codex調査担当は削除した。 |
| 記憶と再利用 | 記憶担当が会話の往復から保存・要約・忘却を判断する。会話には趣向・傾向だけを固定で入れ、詳しい中身は `memory` ツールで読む。記憶の停止・撤回・忘却、Seed候補のpreview/importを実装。整理の実行中・失敗は会話画面の「メモリー整理」に出す（fixture検証済み）。記憶の有効設定と接続状態に従う。ツールチェーンの選択履歴と保存済み取得手順も再利用する。 |
| Personal World | 基盤・部分実装。会話・Memoryの変更取り込み、条件付きの抽出、根拠付き主張の照会・訂正・忘却、依存・影響の判断照会を実装。有効化は設定の `world.enabled`（既定は無効）で、環境変数 `EUMENES_WORLD` は読まない。会話には文脈係がWorldに記録がある対象の名前を候補として入れ、主張はWorld照会の担当（`world.query`）が根拠付きで報告する。収集資料は会話と分けた台帳に置ける。内容が残ったままオフにすると、次回起動は忘却の反映だけの保護モードになる。実モデルの抽出品質や継続仕事への接続など、目指す全体像には残件がある。[実装と制約](api/domains/world/README.md)を参照。 |
| タイマー・予約 | 会話またはタイマー画面からの開始・一時停止・再開・取消と、満了通知。一回・固定間隔の会話予約はAPI（`/api/schedules`）から作り、Eumenes起動中に実行する。予約の作成画面はない。 |
| 画像・音楽・3D | 画像の生成・一覧・取得・削除、楽曲・効果音の生成、保存曲の検索・お気に入り・プレイリスト・再生を接続。LARM側の対応サービスが必要。画像の参照画像編集は未対応。3Dモデルの生成・一覧・表示・名前とタグの変更・削除は実装・固定試験済みで、端末画像のLARM取込は本番LARMで確認済み。3D生成のliveと会話からの受入は未実施。 |
| 計算 | 数値・記号計算、統計・回帰・作図のPythonを、LARMのCPU計算サービスへジョブで送り、状態・取消・成果物を「計算」画面で扱う。実装・固定試験、実CPUでの計算・PNG/CSVの取得・画面表示を確認済み。会話の最終文までの通し受入は未完了。 |
| 図・物体認識・文字認識 | Excalidraw編集画面の準備・保存図の再表示、静止画・短い動画の物体検出と会話への追加、画像・短い動画のOCRと補正案、範囲選択とQR読取り。両画面の「詳細分析」（説明・検索・マスク）は実LARMと稼働画面で確認済み（2026-10-25）。OCRの正式gatewayは画像・動画・取消の実接続を確認済み（2026-10-17）。補正品質の受入は未達で、実カメラの受入は未実施。各gatewayと専用の接続・認証設定が必要。 |
| 文章ナレッジベース | 「文章ナレッジベース管理」を開くとDocling Deskの起動を要求し、準備できたら別タブで開いてログインする。文書の取り込み・Word/PDFの閲覧・OCRはDocling側の画面で行う。別タブの入口とWord/PDFの操作は以前に実接続で確認済み。表示時の起動要求（2026-10-27）は実装・fixture検証済みで、実接続の再受入と配備は未実施。 |
| CLI（シェル） | 画面「CLI」でbackendのログインシェルを操作する。会話の `cli_command` は登録プロジェクトのルートでコマンドを一件ずつ実行し、終わると終了コードと出力の要点を会話へ返す（承認なし）。PTYの子プロセス（Claude Code画面・CLI画面・会話からの実行）にはログインセッションの環境変数だけを渡し、LARMトークン・クラウドのキー・`EUMENES_*` はbackendに留める（2026-10-27）。実装・固定試験済み。ブラウザと実LLMの受入は未実施。 |
| ブラウザ操作 | 利用者のBraveのタブにPlaywright MCP Bridgeで接続し、タブ一覧・撮影・ページ操作（確定操作は承認）を画面「ブラウザ」と会話から行う。Braveの実行ファイルのパスは設定に保存する。実装・固定試験済み。実機のBraveでの受入と実LLMの操作判断は未実施。LARMへの保存は未実装。 |
| パイプライン | 3つ以上の担当を使う決まった手順をJSONの定義として版で保存し、担当の検索で候補にする。実行は既存の委譲で1ステップずつ進める。定義は「パイプライン制作」で協働型の担当と作り、検査・試験運転・公開する。実装・固定試験済み。ブラウザE2E・実機器は未実施。 |
| リソースURI | 生成物や会話の出来事を `eumenes://<種類>/<ID>` で指し、解決・種類をまたぐ検索のAPIと、会話の吹き出しのチップから開く。実装・固定試験済み。live・実機器は未実施。会話からの `resources` 担当と画面への指示は削除済み。 |
| 作業ボード | タスクボードでカードを登録し、Claude CodeまたはCodexへ順番に依頼する。会話からの直接依頼は「Claude Code」画面の作業依頼表を使う。commitとpushはボード上の人の操作に限る。固定試験とブラウザfixtureはあり、実 `claude` のフック確認は記録済み。自然言語受入とCodex側の最終受入は未完了。 |
| 画面の自由制作 | 登録済みの部品（見出し・本文・カード・フォームのほか、画像・紙芝居・状態と式・数式・電卓・図解）の範囲で、会話または「UI自由制作」から協働型の担当とOpenUI画面を作り、同じ作品を手直しできる。任意のHTML・外部API実行は対象外。固定試験・ブラウザE2E済み。実モデル（live）は未実施。 |
| 再起動時の扱い | キュー上の未着手ジョブ、タイマー満了、会話予約は再起動後に再開する。実行中だった会話生成・音声ターン・担当の仕事は中断（`backend_restarted`／`backend_stopped`）として記録し、自動では再開しない。LARMの接続は終了時に解放せず、次の起動で同じ接続に戻る（別プロセスのliveで入力キャッシュの再利用を確認。backend再起動後の実会話では未確認）。再起動をまたぐ仕事の継続は到達点であり、現状は未実装。 |
| 作業委任 | Codex・dotsへの依頼、許可範囲、質問・進捗・報告、停止確認を保存する。dotsとは追加の受付サーバーを置かずに、メッセージの送受信（「dots メッセージ」）と作業委任（「dotsの仕事」）を行う。メッセージは実dotsとの3往復を試験用の認証で確認済み（2026-10-25）。直接CLIを実行するcoding runnerの本番隔離は未完成。詳しくは下記の制限を参照。 |
| OpenUIアーティファクト | 会話と並べるタブに、設定・TODOリスト・タイマー・画像・音楽・図などの登録済みviewを表示・合成する。JSONには表示定義を持ち、状態・認証・操作の検査はホスト側が担当する。 |
| 俯瞰 | 記録・実行状態の照会、TODOリスト、Spatial背景の監視銀河（Eumenes 10体・LARM 4体）がある。Spatialは既存APIの実測とLARMの読み取り専用監視APIへ接続済み（fixture）で、外部連携は未計測、LARM監視APIの本番公開と実画面確認は残る。状況と仕事を統合する俯瞰モニターの完成ではない。[現在の表示基盤](docs/backgrounds.md)を参照。 |
| ハーネスの自己改善 | 採用必須の構想。既存の試験・評価・実行記録を、改善候補の期限付き試験運用、本採用・棄却、切り戻しへつなぐ全体機構は、実装・受入済みとしていない。 |

ツールチェーン・履歴・Web調査は既定で有効です。`EUMENES_TOOLCHAIN_ENABLED`、`EUMENES_HISTORY_TOOLS_ENABLED`、`EUMENES_WEB_RESEARCH_TOOLS_ENABLED`で切り替えられます。Worldのオン／オフは環境変数ではなく設定の `world.enabled` です。embeddingが利用できない間は利用可能な全候補を提示します。候補の検索は担当の選択を代行せず、モデルの報告や判断の正しさを保証するものでもありません。詳細は[ツールチェーン](docs/toolchain.md)を参照してください。

## セットアップと起動

前提は`package.json`の指定に合わせた **Bun 1.4.4** と、Vite 8の要件を満たす **Node.js 20.19以降の20系、または22.12以降** です。`bun run dev`はAPIをBun、画面用ViteをNode.jsで起動します。

1. リポジトリのルートで`bun install`を実行します。`postinstall`でDesignSystemをビルドします。
2. 必要に応じて`.env.example`を`.env`へコピーし、backendで使う`LARM_API_TOKEN`を設定します。すでにexportしている場合はその値を使えます。`EUMENES_API_TOKEN`は省略可能で、初回に`data/keys/api.token`へ自動生成し、API・Vite・CLIで共有します。明示指定する場合は24文字以上にします。
3. `bun run dev`を実行し、`http://127.0.0.1:5173`を開きます。APIの既定待受は`127.0.0.1:8787`です。API起動後にViteが起動し、Ctrl+Cで両方を終了します。すでに起動中のAPIがあれば終了してから実行してください。
4. 「アーティファクトを開く」→「設定」→「AIと接続」から、LARM接続を保存します。接続先の正本はSQLiteの保存設定で、未登録の間はLARMへ接続しません。保存済みの接続・Profileは維持します。Profileの既定値はなく、設定画面で選んで保存するまでLARMへ接続しません。
5. 会話欄から文字を送信するか、「音声を開始」でマイクを許可します。「マイクを停止」で入力を止め、読み上げのON/OFFはミュートで切り替えます。

個別起動は別々のターミナルで`bun run start`と`bun run dev:web`を使います。API・Vite・CLIには同じAPI認証とデータ保存先の環境設定を使ってください。ViteのローカルproxyがAPI認証を付け、LARM認証やクラウドキーはbackend内に保持します。既定DBは`data/eumenes.sqlite3`、変更には`EUMENES_DB`を使います。Web取得のキャッシュはDBと同じ場所の`cache/web-research-v2.sqlite3`です。DBと`data/keys/`内の鍵は一緒に保全してください。`bun run db:backup`はAPI停止中にDBのバックアップを作ります（起動中は拒否します）。

ツールチェーンのSeedはリポジトリで管理し、API起動時に自動投入します。新しいDBでも担当・SKILL・ツール・画面定義が入り、別のインポート操作は不要です。会話本文、実行履歴、生成物、接続先・認証情報は含みません。同じSeedの再投入では無効化や公開版の手動切替を保持します。保存場所と更新方法は[Seedと初期化](docs/toolchain-extension.md#11-seedと初期化)を参照してください。

クラウドを使う場合は設定の「AIと接続」で登録し、用途に割り当てます。OpenAI互換APIに加え、会話用途はCodex SDK・Claude Agent SDK（サブスクリプション／APIキーを接続ごとに選択）のadapterがあります。自動切替は保存した許可・用途・代替先に従い、未登録の代替先へは送信しません。詳しくは[セットアップ](docs/setup.md)、[設定](docs/settings.md)、[LARMの接続とサービス](docs/larm.md)を参照してください。

## 画面の入口

- 会話で調査・履歴確認・タイマー・制作・計算・CLI実行・ブラウザ操作・作業委任を依頼します。利用可能な担当と接続設定に応じて、確認質問や結果が返ります。
- 右上の「アーティファクトを開く」から、TODOリスト、画像生成、音楽・効果音生成、音楽プレイリスト、3Dモデル、図を描く・編集する、映っている物を調べる、文字を読み取る、文章ナレッジベース管理、計算、UI自由制作、パイプライン制作、ブラウザ、Claude Code、CLI、タスクボード、dotsの仕事・メッセージ、タイマー、設定などを開けます。adapterが使えない入口（例: `claude`がPATHにない）は表示されません。会話とアーティファクトの表示幅を調整できます。
- 設定アーティファクトでは、会話、AIと接続、音声と入力、外部作業、表示を編集し、「設定の変更をすべて保存」で共通下書きを保存します。記録、記憶、Worldの閲覧、Google連携、動作確認、読み方辞書、変更一覧、dotsの設定、ブラウザの設定はそれぞれの画面から開きます。Google連携の実アカウント受入と配布用クライアントの同梱は未実施です。
- 「動作確認」は個別の接続テスト・生成を行い、「自己診断」は接続状態を確認します。試用ではサービス利用が発生します。

## CLI

backendを先に起動します。CLIはAPIを利用し、DB writerを起動しません。画面「CLI」（ログインシェル）とは別のものです。`EUMENES_URL`を省略すると`http://127.0.0.1:8787`へ接続します。

```sh
bun run cli -- status --json
bun run cli -- send 'こんにちは' --wait --json
bun run cli -- history main --json
bun run cli -- run <run-id> --json
bun run cli -- cancel <run-id> --json
bun run cli -- web search 'Bun SQLite' --read-pages --wait --json
bun run cli -- web read https://example.com/ --wait --json
bun run cli -- capabilities --json
bun run cli -- toolchain-history list --json
bun run cli -- toolchain-history recipes --json
bun run cli -- memory status --json
bun run cli -- memory list --json
bun run cli -- memory seed preview /absolute/path/to/seed.jsonl --json
bun run cli -- memory seed import /absolute/path/to/seed.jsonl --json
bun run cli -- timer list --json
```

`send`は標準入力も読めます。送信結果が不明な場合は、表示されたrequest IDを`--request-id <UUID>`で指定して同じ要求を照会・再試行できます。`--json`の結果はstdout、診断はstderrです。終了コードは成功`0`、引数・認証`2`、処理失敗`3`、取消・待機結果不明`4`、接続不能`5`です。調査担当の`task`／`task-report`／`task-cancel`と、委任作業の`tasks`は別のコマンドです。詳細は[CLIのコマンド実装](cli/commands/index.ts)、[Web取得](docs/web-research.md)、[委任タスク](docs/delegated-tasks.md)を参照してください。

## 検証とログ

以下は実行用のコマンドです。このREADME更新ではコード・既存試験・記録を読み取りで照合しており、試験やサービス起動は実行していません。

| コマンド | 対象 |
| --- | --- |
| `bun run typecheck` | `bun check`による型チェック |
| `bun run verify -- --domain dialogue` | 静的検査（境界・SystemContext・サイズ・SQL境界・domain表・整形・lint・型）は domain を指定してもリポジトリ全体に実行し、対象domainの違反だけを失敗、範囲外は警告として表示・記録する。試験は対象domainの分 |
| `bun run test:domain -- conversation` | 指定domainが所有するAPI・Webの試験 |
| `bun run test:search` | 検索担当・文脈・API結合の固定試験 |
| `bun run verify:all` | 全体の境界・文書整合・型・単体／API結合試験、DesignSystem、Web build と初期JSのgzipサイズ上限（`bun run bundle:check`。ブラウザE2Eは別実行） |
| `bunx playwright test tests/browser/excalidraw.spec.ts` | 指定domainのブラウザE2E（例: Excalidraw） |
| `bun run build:web` | DesignSystemとWebをビルドし、画面の成果物を`dist-web/`へ出力 |

GitHub Actionsの`verify`は手動起動（workflow_dispatch）だけで、pushやPRでは動きません。

実LARMへのASR・LLM・TTS疎通は、保存済み接続と音声ファイルを用意して実行します。

```sh
EUMENES_LIVE_ASR_WAV=/absolute/path/speech.wav EUMENES_LIVE_EXPECT_TEXT=こんにちは bun run verify:live -- --domain larm
```

これは個別操作の疎通で、ブラウザ再生や実マイクでの循環受入には数えません。fixture、実接続（live）、実機器の結果を分け、過去の成功記録を現在の全体合格とは扱いません。手順は[検証](docs/verification.md)、記録の入口は[spec索引](spec/README.md)です。

障害調査は`bun run logs -- --level warn`から始めます。既定のJSONLログは`data/logs/api.jsonl`で、runId・jobId・HTTPの`X-Request-Id`を使って追跡します。詳細は[ログの確認](docs/logging.md)を参照してください。

## 制限と未完了の受入

- 実マイク・ヘッドホンによる3往復と再生中割込み、機器ごとの権限・echo、学習済み発話検出の実録音の受入は未完了です。録音中の逐次ASRは未実装です。[音声受入記録](docs/acceptance.md)を参照してください。
- 主会話と補助は、どちらも保存済みのProfileで独立したSessionを持ちます。待機・履歴分離の実接続記録が過去にありますが、この更新では実接続を再検証していません。[LARMの説明と検証記録](docs/larm.md)を参照してください。
- 直接CLIを実行する委任は`EUMENES_DELEGATED_TASKS_ENABLED`が既定で無効です。有効化だけでは本番隔離を満たさず、coding runnerは`isolation_not_verified`で実行不可です。dots連携は製品側の処理と一部の実接続記録がありますが、委任の新規Sessionから成果返却までの受入は未完了です。[runnerの残工程](docs/coding-runner.md)、[dotsの受入状況](docs/dots.md)を参照してください。
- 個別のサービスや画面の成功を、専属アシスタント全体の完成認定には使いません。[Excalidraw](docs/excalidraw.md)、[物体認識](docs/object-recognition.md)、[設定](docs/settings.md)の受入範囲は各文書と検証記録を参照してください。計画書には未実装・部分実装の内容を含みます。

## 構成とドキュメント

| 場所 | 役割 |
| --- | --- |
| `api/application/` | `server.ts`でサービスを組み立て、API・実行キュー・ライフサイクルを接続する |
| `api/domains/` | 会話、推論、調査、記憶、委任、制作などの業務処理・保存・公開操作・試験 |
| `web/src/`、`client/`、`cli/` | Reactの画面、共通API client、CLI入口`cli/index.ts` |
| `packages/` | DesignSystem、OpenUI用artifact-ui、coding runner、dots MCP |
| `vendor/` | 取り込んだ会話エージェント（`eumenes-agency`）、記憶（`eumenes-memory`）、World（`eumenes-world-model`） |
| `scripts/`、`tests/browser/` | 起動・検証・ログ・実接続確認のスクリプト、ブラウザfixture |
| `docs/`、`spec/` | 利用・運用・実装の説明、計画・設計・検証記録 |

[docs索引](docs/README.md)と[domain一覧・所有境界](docs/domains.md)が文書の入口です。用途別には以下を参照してください。

- 調査・拡張：[ツールチェーン](docs/toolchain.md)、[Web取得](docs/web-research.md)、[登録と拡張](docs/toolchain-extension.md)、[拡張の検証](docs/toolchain-extension-verification.md)、[リソースURI](docs/resources.md)
- 制作・観測：[画像](docs/images.md)、[チャットの画像入力](docs/chat-images.md)、[音楽を含むLARMサービス](docs/larm.md)、[3Dモデル](docs/model3d.md)、[計算](docs/compute.md)、[Excalidraw](docs/excalidraw.md)、[物体認識](docs/object-recognition.md)、[OCR](docs/ocr.md)、[文章ナレッジベース](docs/docling.md)、[OpenUI](docs/openui-artifact.md)
- 作業：[タスクボード](docs/kanban.md)、[Claude Code画面](docs/terminals.md)、[CLI画面](docs/shell.md)、[ブラウザ](docs/browser.md)、[dots](docs/dots.md)、[委任タスクの基盤](docs/delegated-tasks.md)、[CLI runner](docs/coding-runner.md)、[コーディング監督](docs/coding-supervision.md)
- 運用・設計：[設定](docs/settings.md)、[記憶](docs/memory.md)、[Google連携](docs/google-accounts.md)、[SSE通知](docs/realtime.md)、[spec索引](spec/README.md)
