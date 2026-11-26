# Codex / Claude Code が Eumenes の Toolchain を使う計画

2026-11-26 JST・第2稿。状態: 計画案・実装前。利用者の訂正を反映し、Toolchain を検索・選択して使う主体を Codex / Claude Code、その先の専門処理の実行主体を Eumenes の既存サブエージェントとする。以下の操作名・公開範囲は実装案である。

## 1. 目的と責務

Codex / Claude Code が、必要なときに Eumenes の Toolchain を検索し、候補を読み、自分で選んだ Toolchain に仕事を渡す。Eumenes は選ばれた Toolchain の既存サブエージェントを動かし、進捗・質問・結果・成果物を返す。

Eumenes の会話エージェントによる再解釈・再選定は挟まない。Eumenes のサブエージェントを Codex 内に複製せず、Eumenes の既存 package・SKILL・ツール・adapter・保存済み推論設定で実行する。

| 段階 | 判断・操作する主体 | Eumenes が提供するもの |
| --- | --- | --- |
| 能力が必要か判断する | Codex / Claude Code | 短い MCP の入口説明 |
| Toolchain を探す | Codex / Claude Code が検索を呼ぶ | 既存の検索機構と、利用可能な候補 |
| 候補を比較し使う担当を決める | Codex / Claude Code | 各 Toolchain の用途・外部向け利用契約 |
| 選んだ Toolchain に依頼する | Codex / Claude Code | 選択の検証、既存実行への受付 |
| 専門的な処理を進める | Eumenes の既存サブエージェント | 既存の SKILL・ツール・推論・domain 操作 |
| 質問に応じる・結果を使う | Codex / Claude Code | 質問、状態、結果、根拠、成果物 |

例: Codex が「過去の設計判断を探す能力」を検索し、会話履歴の調査 Toolchain の説明を読んで選ぶ。Codex がその Toolchain を指定して依頼すると、Eumenes の会話履歴調査サブエージェントが実行する。結果を使って実装を続けるのは Codex である。

## 2. 再利用するものと追加が必要なもの

| 対象 | 現行の所在・契約 | 本計画での扱い |
| --- | --- | --- |
| 候補検索 | `api/application/toolchain/toolchain-routing.ts`、dialogue の `executor-search.ts` | 既存検索を公開操作で利用する。順位・縮退方式を変えず、最終選択は呼出し元に残す |
| Toolchain 定義 | capabilities の bundle・公開 revision・binding | 同じ正本から候補と外部向け利用契約を作る。MCP 専用の能力定義を複製しない |
| 担当への依頼 | `executor-delegation.ts` の `assignTo`、`AgencyLayerPort.assign` | 選択検証と既存 assignment の受付・起動を再利用できる公開口へ整理する |
| 実行 | `always-on-flow.ts`、agent-runtime、各担当の lifecycle | 選択済み revision を渡し、同じ専門担当を動かす |
| 制御 | `always-on-assignments.ts`、担当の公開制御操作 | 質問・回答・変更・取消の意味を維持して外部へ接続する |
| 結果 | 作業報告メモ、resource 台帳、実行の view | 保存された結果と成果物を参照する |
| Memory MCP・Dots MCP | `docs/memory.md`、`packages/dots-mcp` | 既存契約を維持する。新入口にイベント購読や外部チャット継続を要求しない |
| SDK worker | `packages/coding-runner/src/sdk-engine.ts` | 既存の通常時 `mcp_servers={}` を維持する。利用者が使いたい Codex / Claude Code への接続とは分ける |

現行の `execution-source.ts` は `manual / voice` の利用者発言を実行根拠にし、`controlAssignment` も利用者発言を要求する。このため現在の会話用関数を外部から呼ぶだけでは成立しない。外部から Toolchain を利用する明示的な origin と受付契約を追加する。

## 3. MCP 操作案

名称は仮称。外部側の基本手順は `find_toolchain → describe_toolchain → delegate` とし、実行中は状態・質問・結果を取得する。短い候補の説明で十分なら詳細取得は省略できる。

| 操作 | 入力の中心 | 返却するもの |
| --- | --- | --- |
| `find_toolchain` | 検索文、上限 | 利用可能な候補の ID・revision・題・要約・用途・生成物・検索結果の参照 |
| `describe_toolchain` | 検索結果で提示された候補の参照 | 選んだ Toolchain の外部向け利用方法、入力項目、必要な資料、出力、実行型、制御の対応範囲 |
| `delegate` | 選んだ候補の参照、冪等鍵、依頼文、必要な入力・資料参照 | 永続の `requestId`、選んだ Toolchain と revision、受付 receipt |
| `get_assignment` | `requestId`、任意の cursor・有限の待機時間 | 担当の状態・進捗・質問・可能な制御・結果概要・結果参照 |
| `read_assignment_result` | `requestId`、提示済みの結果参照、cursor | 結果本文・根拠・成果物・次 cursor・失効や切詰めの情報 |
| `control_assignment` | 操作の冪等鍵、`requestId`、`answer / amend / cancel`、質問参照・対象の版、本文 | 操作の receipt、適用・競合・拒否の区別 |

`describe_toolchain` は Codex がその Toolchain を使うための説明であり、内部サブエージェントの実行用 SystemContext・全 SKILL・個別ツールの schema を読み込ませる操作ではない。外部向けの入力契約が必要なら同じ bundle に版付きで宣言する。

検索だけでは仕事を始めない。`delegate` で Codex が指定した候補を実行し、Eumenes の会話担当へ「どの担当に頼むべきか」を問い合わせない。候補が失効していれば拒否し、再検索・再選択は呼出し元が判断する。

候補参照は依頼元の scope と提示時の revision に結び付け、他の接続や未提示の候補を勝手に実行するために使えないようにする。Toolchain の選択記録は `delegate` の受付と結び付けて既存履歴へ残す。外部 LLM に別の `record` 呼出しを必須にしない。

## 4. backend 側の接続

追加するのは、検索・選択済み Toolchain の受付・照会・制御を外部へ公開する境界である。Eumenes の会話エージェントを新しく起動する経路や、自然言語だけで担当を自動選定する gateway は作らない。

| 部分 | 責務 |
| --- | --- |
| MCP transport | 入出力 schema、接続認証、backend の公開操作の呼出し。製品 DB は開かない |
| 外部受付 domain（仮称 `external-requests`） | 依頼元・候補提示参照・外部 origin・冪等鍵・期限・選択された revision・既存実行への対応参照・制御の受付記録を所有する |
| application の接続処理 | capabilities の検索、既存 assignment と実行の公開口、結果参照を結ぶ。複数 domain の保存を単一 writer の transaction で行う |
| 既存の実行機構・担当 | 専門処理、実行状態、質問、結果、取消、担当の子実行を所有する |

会話用 executor に閉じた検索・依頼・制御処理から、共通に使う公開操作を必要な範囲だけ抽出する。通常会話の利用側も同じ公開口を使い、外部用に同じ起動ロジックをコピーしない。既存の会話経路の判断主体・検索順位・確認方式は変えない。

既存 assignment の保持に Agency の scope/checkpoint が必要な場合は、その lifecycle を再利用する。外部の依頼元と `requestId` で所有者を決め、会話の返事・選定推論・agenda の自発思考を動かす必要がない公開 port を設ける。Agency 本家の変更が必要なら本家で変更し、配布物を取り込む。会話用の scope を偽装して動かさない。

専門担当の実行状態は持ち主の view から読む。外部受付には配送意図・receipt 参照など入口固有の状態だけを保存し、第二の進捗台帳を作らない。

## 5. 一件の実行と復旧

1. Codex が `find_toolchain` を呼ぶ。Eumenes は接続の権限・公開 revision・可用性に合う候補を既存検索から返す。
2. Codex が必要なら詳細を読み、自分で候補を選ぶ。
3. `delegate` でその候補を指定する。backend が候補参照・権限・入力・資料・期限を再検査する。
4. 同じ writer で依頼原文、選んだ revision、安定した開始鍵、配送意図を保存し、既存 assignment / 担当 lifecycle / agent-runtime の起動へ接続する。
5. サブエージェントは Eumenes の既存定義で動く。依頼元は `requestId` で進捗・質問を取得する。
6. 質問の答えや条件変更は同じ実行の制御口に渡す。担当が非対応の変更は拒否として返し、勝手に取消・再作成しない。
7. 既存結果の要約・達成・不足・根拠・成果物を返す。Codex が結果を評価し、次の作業や別の Toolchain の利用を判断する。

同じ依頼元・同じ冪等鍵・同じ内容なら同じ受付へ戻る。内容が違えば競合とする。開始鍵と既存 receipt で再起動後の実行を照合し、応答を失っても二重起動しない。受付成功・担当開始・担当完了を区別する。

一回の `delegate` は一つの選択済み Toolchain に対応する。担当が既存 pipeline 等で子実行を持つ場合はその既存契約に従う。複数の Toolchain をどう組み合わせるかの判断は Codex にあり、MCP 層で別の計画・再選定ループを始めない。

取消は新規配送と結果採用を止め、受理済み実行とその子へ既存の取消を伝える。停止要求と停止確認を区別する。MCP の照会終了・接続断だけでは取消にしない。期限・取消後の遅着結果を採用しない。

現行 `assignTo` の Agency メモリー更新・checkpoint と DB transaction は全体で自動的に原子的になるわけではない。受付保存・assignment 保存・起動・対応参照の確定の各中断点を先に列挙し、既存保存・receipt を使う復旧手順を P0 で確定する。

## 6. 外部 origin と情報の境界

- 外部依頼を `manual / voice` の本人発言に偽装しない。認証済み依頼元・依頼 ID・権限の版・期限・原文 digest に結び付く外部 origin をホストが作る。
- 依頼文・資料・完了条件は作業データであり、接続の権限を拡張しない。候補提示・開始・制御・結果取得時に有効性を検査する。
- 外部呼出しは本人の会話依頼とも Agency の自律行動とも区別し、既存の `askedByUser` を無条件に true にしない。利用可能な操作と有限の受付枠を接続設定で明示する。
- 下位 domain は外部受付 domain を import せず、純粋な origin 契約と application から渡す検査 port を使う。
- 初版は利用者管理のローカル接続を提案する。stdio の薄い bridge から認証付き backend 受付を呼び、接続情報はモデル入力に返さない。既存クライアント設定を自動変更せず、bridge が backend やモデルを自動起動する経路を設けない。
- 個人の主会話へ外部依頼を混ぜず、通常の記憶抽出の対象へ自動で加えない。作業結果の報告と Memory の保存・訂正・忘却を区別する。
- 主会話の表示・読み上げを待たずに結果を取得できるようにする。可聴出力は利用者が開いた Eumenes Web のブラウザー内だけに限る。

## 7. 初期コンテキストと結果の容量

初期には MCP の短い説明だけを公開する。Toolchain 検索の結果は少数の候補と短い説明にし、詳細は選んだ候補だけを取得する。専門担当の SystemContext・SKILL・実行用ツールとモデル設定は Eumenes 側に留める。

Codex の既存コンテキストを丸ごと送らず、その Toolchain への依頼に必要な条件と資料だけを渡す。結果も状態・要約を基本にし、本文・根拠・成果物は必要時に読む。外部クライアントが `eumenes://` をそのまま開けるとはせず、既存の資料・成果物の公開操作へ結び付いた参照を返す。

本文・題・URL・JSON 枠を含む実際の提示量、cursor、切詰め、参照の失効を契約にする。既定上限は P0 で決める。取得済みの外部コンテキストを忘却後に遡って消せるとは約束しない。

Codex の遅延ロードは利用できる環境で使うが、機能の正しさの前提にしない。専門処理の入力が Eumenes 側へ移る分も含め、依頼元と Eumenes の token・推論回数・待ち時間を分けて測る。

## 8. 初版の対象

| 実行型・能力 | 方針 |
| --- | --- |
| 会話履歴調査・Web 調査 | 初回受入の代表例。Codex が実際に検索・選択し、Eumenes の既存担当が実行したことを確認する |
| instant | 既存の即時実行を利用する。架空のサブエージェントや assignment を作らず、外部の受付 ID から結果を取得できるようにする |
| command・画像生成 | 次の代表例。同じ bundle・既存担当・adapter と生成結果を利用する |
| task・pipeline | 担当が持つ子実行の観測・取消・結果回収を通してから公開する |
| session 型 | 同じ専門担当との複数往復、作品の target、未保存状態、画面の所有を接続する後続段階とする。対応前は外部候補に出さない |
| Memory / World / Skill | 既存の登録済み能力だけを公開する。不足分を新設する場合は別の版付き bundle と登録 adapter で追加する |
| コーディング・外部委譲の担当 | 初回公開から外す案。呼出し元への循環を防ぐ origin と実行系譜を確認してから広げる |

公開範囲は同じ能力定義・binding と接続の grant から決め、MCP 用のモデル名・profile・担当名の固定分岐を追加しない。新しい外部向け説明や schema は既存 revision の本文を上書きせず、新 revision として宣言する。[登録手順](../docs/toolchain-extension.md)と[検証手順](../docs/toolchain-extension-verification.md)に従う。

## 9. 実装の段階

| 段階 | 作業 | 完了条件 |
| --- | --- | --- |
| P0 契約確定 | 候補参照・詳細・選択指定・外部 origin・実行参照・質問・結果・復旧手順を確定 | Codex が選び Eumenes が実行する境界をレビューできる。計画への合意後に実装する |
| P1 検索と説明の MCP 化 | 同じ catalog と検索から候補を返し、選んだ候補の外部向け説明だけを取得する | 検索で実行されず、権限・公開状態に合う候補を返す。選択用の Eumenes LLM 呼出しはない |
| P2 選択済み担当の実行 | 外部受付、選択検証、既存 assignment / 実行の公開口、結果照会を接続する | Codex が指定した revision の既存サブエージェントが動き、Eumenes の会話担当が再選定しない |
| P3 制御と復旧 | 質問・回答・変更・取消・期限・中断・再送・checkpoint 復旧を接続する | 同じ担当に制御が届き、二重実行・古い質問の採用・取消後の結果採用がない |
| P4 実クライアント受入 | 実 Codex / Claude Code が検索・比較・選択・依頼・結果利用を行う | 調査担当で通し確認し、実行主体と revision の証拠、コンテキストと待ち時間の計測を残す |
| P5 対象拡張 | 画像、task/pipeline、session を各契約の受入後に公開する | 各型で結果・成果物・質問・停止の代表例を確認する |

新規の想定配置は `api/domains/external-requests/`、`api/application/external-requests/` と MCP bridge。transport は既存 package の再利用を優先する。現行の会話用処理から公開口を抽出する際も、通常会話の意味は維持する。

既存の Toolchain・Agency 関連ファイルには他作業の未コミット変更がある。実装前に前提と差分を再確認する。本計画の文書改訂では製品コード・設定・既存差分を編集しない。

## 10. 検証と受入

| 種類 | 主な確認 |
| --- | --- |
| 固定試験 | 同じ検索結果・外部向け契約、指定した候補の実行、未提示・失効候補の拒否、再選定用 LLM 呼出しがないこと、失敗・不足・資料・容量・cursor・権限境界 |
| 中断・競合 | 同じ鍵の再送、違う内容の競合、開始前取消、取消と完了の競合、受付・checkpoint・起動の各中断点からの復旧 |
| 回帰 | 通常会話の検索・選定・依頼、既存 assignment、Memory MCP・Dots MCP、SDK worker の設定分離 |
| 実モデル・実クライアント | Codex / Claude Code 自身が候補を選び、Eumenes の実サブエージェントの結果を使う。担当の自己申告だけで実行主体を判断しない |
| 画面・実機器 | 公開した session や成果物表示など、対象に応じて個別に確認する |

実装後は新 domain と影響する `capabilities`・`dialogue`・`tool-runtime`・`agent-runtime` 等を選び、`bun run verify -- --domain <name>` で確認する。application の結合試験と MCP の protocol 試験はファイルを明示する。ブラウザー E2E は対象 domain のファイルだけを指定する。

相関は `discoveryRef → requestId → toolchainRevision → assignment/executionRoot → runId → resultRef` で追う。通常ログは ID・固定分類・状態・経過時間のみとし、依頼本文・記憶・秘密・設定・Provider 生応答を出さない。MCP 未接続・接続のみ・候補検索後・実行結果取得後のコンテキストを分けて計測する。

成功条件は、Codex / Claude Code が Eumenes の Toolchain を自分の道具として検索・選択し、選んだ先の既存 Eumenes サブエージェントが処理し、質問・失敗・取消を含む結果が同じ受付 ID で取得できることである。

文書改訂時点では計画のみ。製品実装、固定試験、live 受入、サーバー操作は未実施。

## 参照した現行文書

- [担当への依頼と結果の報告](../docs/assignments.md)
- [Toolchain](../docs/toolchain.md)
- [担当への依頼・第2段の実装設計](toolchain-assignment-stage2-implementation-2026-11-25.md)
- [Memory と外部 CLI/MCP](../docs/memory.md)
- [SDK runner](../docs/coding-runner.md)
- [ツールチェーンの登録と拡張](../docs/toolchain-extension.md)
- [検証手順](../docs/toolchain-extension-verification.md)
