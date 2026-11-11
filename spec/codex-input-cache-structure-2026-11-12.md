# Codex 経路の入力キャッシュ構造の是正

- 日付: 2026-11-12
- 状態: 設計（未実装）。利用者の合意待ち
- 対象: 接続種別 `codex-sdk` の全呼出し（会話・agency・steward・router-structure・専門担当・skillsmith ほか）
- 位置付け: [context-window-layout-spec-2026-10-25.md](context-window-layout-spec-2026-10-25.md) §8 が LARM で実現している「先頭を共有してキャッシュに乗せる」を、Codex 経路で成り立たせる。会話の文脈の組み立て（host が毎回組み立てる）、会話の思考量、背景の呼出しの頻度は変えない
- 利用者の決定（2026-11-11）: 会話の思考量は維持する。まず入力キャッシュが使えない構造を正す

## 1 測った事実

### 1.1 消費（実測、2026-11-11 23:30〜23:41 の会話、14発話）

| 項目 | 値 |
| --- | ---: |
| クラウド LLM の呼出し | 61回 |
| 入力 | 788,495 token |
| うちキャッシュ読取 | 161,664 token（20%） |
| 出力 | 11,019 token（うち思考 8,289） |
| 1発話あたりの入力 | 3.5万〜7.4万 token |
| 返事が出るまで | 7〜37秒 |

キャッシュに当たった呼出しの割合（直近2日、同じ種類の前回呼出しから5秒以内でも変わらない）:

| 種類 | 呼出し | 当たった割合 | 当たったときの読取量 / 入力 |
| --- | ---: | ---: | --- |
| 会話（1回目） | 53 | 19% | 約12,700 / 約14,900 |
| 会話（同じターンの2回目以降） | 5 | 0% | — |
| agency | 216 | 22% | 約6,300 / 約9,300 |
| steward | 92 | 13% | 約3,700 または 約11,500 / 約17,800 |
| router-structure | 11 | 18% | 7,296 / 約9,800 |

読取量はすべて128の倍数。OpenAI の文書の「旧来モデルの方式」（一定間隔の区切り、`prompt_cache_key` による振り分け）で数えられている。

### 1.2 Codex が実際に送る要求（捕捉、通信なし）

`codex-cli 0.162.1` の `app-server` を、今のアダプタと同じ設定で起動し、接続先だけを検証用の受け口に向けて要求本文を記録した（モデルは呼ばない）。`thread/start` の `baseInstructions` に `HOST-INSTRUCTIONS`、`turn/start` に `A-TURN-1` を渡したときの `input`:

```
additional_tools                 17,667字  functions{exec, wait, request_user_input, request_user_input_async}
                                           collaboration{spawn_agent, send_message, wait_agent, list_agents, followup_task, interrupt_agent}
developer[HOST-INSTRUCTIONS]               ← Eumenes の system とツール一覧
developer[<skills_instructions>    5,031字  ← 利用者個人の ~/.codex/skills の一覧
        + <permissions instructions> 341字
        + <collaboration_mode>       920字]
developer[<multi_agent_role>       2,400字]
developer[<multi_agent_mode>         271字]
user[# AGENTS.md instructions      1,896字  ← 利用者個人の ~/.codex/AGENTS.md
   + <environment_context>           515字] ← cwd（呼出しごとに違う一時ディレクトリ）と日付
user[A-TURN-1]                             ← Eumenes の資料・履歴・今回の発言
```

同じ要求の `prompt_cache_key` はスレッド ID、`reasoning.effort` は `high`（`~/.codex/config.toml` の `model_reasoning_effort` の値）。

### 1.3 キャッシュが使えない原因

| # | 原因 | 根拠 | 影響 |
| --- | --- | --- | --- |
| 1 | 呼出しごとに新しいスレッドを作るため、`prompt_cache_key` が毎回変わる | 捕捉。スレッド2本で鍵が別、同じスレッドの2回目は同じ鍵 | 同じ先頭でも同じキャッシュへ届くのは偶然（約2割） |
| 2 | Eumenes の本文の前に、呼出しごとに変わる `<environment_context>` が入る | 捕捉。cwd は `mkdtemp` の一時ディレクトリ（`cloud-agent-codex.ts:148`） | 資料・履歴は、鍵が合っても一致しない |
| 3 | 同じターンの2回目（ツール結果の後）も、新しいスレッドで全文を送り直す | 実測。2回目以降の読取は 0/5 | ツールを1回使うたびに約1.5万 token を読み直す |

同じ捕捉で分かった、キャッシュ以外の問題:

| # | 問題 | 影響 |
| --- | --- | --- |
| 4 | 利用者個人の Codex の設定が会話に入る（AGENTS.md・スキル一覧・`model_reasoning_effort`・MCP） | 無関係な指示が毎回入る。思考量を指定しない呼出しは個人設定の `high` で動く |
| 5 | Codex 組込みのツール定義と役割文が毎回入る（合計 約20,300字） | 固定の量。キャッシュに乗れば読取になる（§7 の1） |
| 6 | 呼出しごとに `codex app-server` を起動し、初期化・`config/read`・`thread/start` を行う | 出力14 token の呼出しでも6秒以上 |

## 2 直す構造

### 2.1 全体

| 項目 | 今 | 本書 |
| --- | --- | --- |
| Codex のホーム | 利用者個人の `~/.codex` | Eumenes 専用（§2.2） |
| Codex が足す文 | §1.2 の全部 | ツール定義と役割文だけ（§2.3） |
| プロセス | 呼出しごとに起動 | 常駐（§2.4） |
| スレッド | 呼出しごとに新規・使い捨て | 先頭ごとに固定し、使い終えたら先頭まで巻き戻す（§2.5） |
| 同じターンの2回目 | 全文を送り直す | 増えた分だけを同じスレッドへ足す（§2.5） |
| 思考量 | 指定なしは個人設定を継ぐ | 毎回明示する（§2.6） |
| cwd | 呼出しごとの一時ディレクトリ | プロセスごとに固定の空ディレクトリ |

### 2.2 Eumenes 専用のホーム

| 項目 | 内容 |
| --- | --- |
| 場所 | データディレクトリの下の `codex-home/`（SQLite と同じ場所。`CODEX_HOME` として渡す） |
| ログイン | API キーの接続は今と同じ `CODEX_API_KEY`。CLI ログインの接続は、`codex-home/auth.json` を個人の `auth.json` へのシンボリックリンクにする（複製しない） |
| 起動時 | `codex-home/` の中身をリンク以外すべて消して作り直す |
| なくなるもの | 個人の AGENTS.md・スキル・MCP・既定モデル・思考量の混入。アダプタの `config/read` と MCP の無効化（`codex-app-server.ts:147-174`） |

確認済み: 専用ホームでは `# AGENTS.md instructions` が入らない。リンク越しのログイン書込みでリンクは保たれ、実体が更新される（`codex login --with-api-key` で確認）。

### 2.3 Codex が足す文を止める

プロセスの起動引数（`-c`）に足す。確認は §1.2 と同じ捕捉による。

| 止めるもの | 設定 | 確認 |
| --- | --- | --- |
| `<skills_instructions>` | `skills.include_instructions=false` | 済み |
| `<permissions instructions>` | `include_permissions_instructions=false` | 済み |
| `<collaboration_mode>` | `include_collaboration_mode_instructions=false` | 済み |
| `<environment_context>` | `include_environment_context=false` | 済み |
| `# AGENTS.md instructions` | 専用ホーム（§2.2） | 済み |
| シェルの写し（ホームへの書込み） | `features.shell_snapshot=false` | 未確認 |

止めた後の `input`（捕捉。専用ホーム）:

```
additional_tools
developer[HOST-INSTRUCTIONS]
developer[<multi_agent_role>]
developer[<multi_agent_mode>]
user[A-TURN-1]
```

### 2.4 常駐プロセス

| 項目 | 内容 |
| --- | --- |
| 単位 | 「コマンド・専用ホーム・認証（キーの有無と値）・接続先・Web検索の有無」の組ごとに1つ |
| 起動 | その組の最初の呼出しで起動する。backend の起動時には起動しない |
| 終了 | backend の終了時に止める。異常終了したら次の呼出しで起動し直す（スレッドは作り直し） |
| 1つのプロセスで | 複数のスレッドを同時に動かす（捕捉で確認済み）。通知はスレッド ID で振り分ける |
| 出力の上限 | 今のプロセス全体の4 MiB を、ターンごとの上限に変える |
| cwd | プロセスごとに固定の空ディレクトリ。呼出しごとの `mkdtemp` と後始末はやめる |

### 2.5 固定スレッドと巻き戻し

host は今と同じく、毎回 system と messages を組み立てて渡す。アダプタが、それを同じスレッドに載せる。

**スレッドの見分け（同じなら同じスレッドを使う）**

| 要素 | 理由 |
| --- | --- |
| プロセス（§2.4 の組） | 別プロセスのスレッドは使えない |
| モデル | キャッシュはモデルごと |
| `baseInstructions`（system＋ツール一覧）の内容 | 先頭そのもの |
| 出力の schema の内容 | 先頭の一部として数えられる |
| 思考量 | 同上 |

**呼出しの手順**

| 条件 | すること | 記録する `mode` |
| --- | --- | --- |
| 見分けが同じで空いているスレッドがあり、今回の messages が「そのスレッドに載っている分」の続きである | 増えた分だけを `turn/start` で送る | `append` |
| 見分けが同じで空いているスレッドがあるが、続きではない | `thread/revert` で先頭まで戻し、messages 全部を送る | `reset` |
| 空いているスレッドがない | スレッドを作り（`ephemeral: false`）、messages 全部を送る | `new` |

- 「続きである」の判定: スレッドに送った各 message の内容のハッシュを順に持つ。今回の messages の先頭がそれと一致し、その直後が assistant の message で、その後ろに1件以上あること。assistant の message はスレッド自身の出力に当たるので送らない。
- 全部を送るときの文面は今と同じ（`promptParts` の出力）。増えた分だけを送るときは、増えた messages を同じ書式（`turn-context` の前置き＋JSON）で送る。
- 同じ見分けの呼出しが重なったら、別のスレッドを使う。1つのスレッドは1度に1ターンだけ動かす。

**1ターンでツールを1回使う会話の例（スレッドが受け取る順）**

```
1回目  reset   user[資料・履歴・今回の発言]            → assistant[ツール呼出しの JSON]
2回目  append  user[ツールの結果]                      → assistant[返事の JSON]
次の発話 reset （先頭まで戻す）user[資料・履歴・次の発言] → …
```

どの回も、先頭（ツール定義・Eumenes の system・役割文）は同じ鍵・同じ内容で届く。2回目は1回目の入力と出力もそのまま前に付く。

**確認済み（捕捉）**: 保存するスレッドは `thread/revert` の後、先頭だけに戻り、鍵は変わらない。使い捨てのスレッド（`ephemeral: true`）は `thread/revert` が失敗する。同じスレッドの2回目以降に `<environment_context>` は足されない。

**スレッドの片付け**

| とき | すること |
| --- | --- |
| 10分使われなかった | `thread/delete` し、ホームの記録ファイルを消す |
| 同じ見分けの空きが2本を超えた、または全体で32本を超えた | 最も古いものを同上 |
| 取消（利用者の割込みなど） | `turn/interrupt` し、終了通知を待つ。スレッドは残し、次に使う前に先頭まで戻す |
| 割込みが2秒で終わらない、ターンが失敗した | そのスレッドを捨てる |
| 忘却（`revokeAgentAttempts` が呼ばれたとき） | 全スレッドを捨て、記録ファイルを消す |
| プロセスの終了・backend の起動 | ホームごと消す（§2.2） |

保存するスレッドは、巻き戻した後も会話の内容を記録ファイルに残す。そのため置き場所を専用ホームに限り、上の表のとおり消す。

**利用量**: Codex の利用量はスレッドの累計で届く。ターンの開始時点の累計を引いた差を、その呼出しの量として記録する（今は「スレッド＝1呼出し」を前提に累計をそのまま使っている。`docs/usage.md`）。

### 2.6 思考量の明示

| 呼出し | 今の実際の値 | 本書 |
| --- | --- | --- |
| 会話（`harness.ts` の `cloudReasoning`） | `high`（明示） | 変えない |
| router-structure ほか `low` を明示するもの | `low` | 変えない |
| 指定しない呼出し（steward・agency の一部など） | `high`（個人設定から） | `high` を明示して送る |

専用ホームにすると個人設定が届かなくなるため、指定しない呼出しは明示しないと Codex の既定（このモデルは `medium`）に変わる。挙動を変えないために今の値を明示する。

### 2.7 記録

| 記録 | 内容 |
| --- | --- |
| ログ `inference.codex_thread`（info） | `mode`（`new`・`append`・`reset`）、生きているスレッド数、既存の `attemptId` ほかの ID。本文は出さない |
| ログ `inference.codex_process`（info） | `started`・`exited`（終了コード） |
| 試行の記録 | 今と同じ列（入力・キャッシュ読取・出力・思考）。値は §2.5 の差 |

## 3 変えないもの

| 項目 | 扱い |
| --- | --- |
| host が渡す system・messages の内容と順序 | 変えない。アダプタは載せ方だけを変える |
| 会話の思考量 | 変えない |
| 背景の呼出し（agency・steward）の回数と時期 | 変えない |
| ツールの選ばせ方（JSON の選択）、返事の流し方 | 変えない |
| Claude Agent SDK の経路、LARM の経路 | 触らない |
| モデル名・profile 名 | コードに書かない（スレッドの見分けには渡された値を使う） |

## 4 効果の見込み

実測ではなく見込み。§6 の live で確かめる。

| 項目 | 今 | 見込み | 根拠 |
| --- | --- | --- | --- |
| 1呼出しの入力 | — | 約3,000 token 減 | 止める文が 6,807字＋AGENTS.md 1,896字 |
| キャッシュに当たる呼出し | 約2割 | 大半 | 鍵と先頭が毎回同じになる。OpenAI の文書は「鍵は振り分けに効くが、当たりを保証しない」としている |
| 当たったときの読取の割合 | 会話 約85%、router-structure 約75%、agency 約68%、steward 約65% | 同じ | 今、当たったときの実測 |
| 同じターンの2回目 | 0% | 1回目の入力のほぼ全部 | 同じスレッドへ足すため |
| 呼出しごとの固定の待ち | 約6秒 | 減る（量は未測定） | プロセスの起動・初期化・`config/read` がなくなる |

## 5 実装の段階

| 段階 | 内容 | 主な場所 | 単独での効果 |
| --- | --- | --- | --- |
| P1 | 専用ホーム、足す文の停止、思考量の明示、`config/read` の削除 | `adapters/codex-sdk.ts`・`codex-transport.ts`・`codex-app-server.ts`・`cloud-agent-codex.ts` | 入力 約3,000 token 減。個人設定の混入がなくなる |
| P2 | 常駐プロセス、固定の cwd、ターンごとの出力上限、終了時の停止 | `adapters/codex-transport.ts`（作り直し）・`cloud-agents.ts`・backend の終了処理 | 固定の待ちが減る |
| P3 | 固定スレッド・巻き戻し・追記・片付け・利用量の差、忘却の連動 | `adapters/codex-threads.ts`（新規）・`codex-app-server.ts`・`service/agent-revoke.ts` | キャッシュが効く |
| P4 | ログ、`docs/logging.md`・`docs/usage.md` の更新、捕捉スクリプトの登録 | `scripts/codex-wire-capture.ts`（新規） | — |
| P5 | live の確認（利用者の開始の指示を待つ） | — | — |

置き換えた古い経路（呼出しごとの起動、使い捨てスレッド、`config/read`）は残さず消す。

## 6 検証

| 区分 | 内容 | 合格の基準 |
| --- | --- | --- |
| fixture（偽の Codex） | `new`・`append`・`reset` の選び分け、続きの判定、重なった呼出しの別スレッド、取消後の巻き戻し、失敗時の破棄、片付け、利用量の差、忘却での全破棄 | 各1件以上の試験が通る |
| 捕捉（実 Codex CLI・検証用の受け口、通信なし） | §2.3 の後の `input` に止めた文がない。`reset` の後の要求が先頭＋今回分だけで、鍵が同じ。`append` の要求が前回分の続き | 記録した `input` の並びが §2.3・§2.5 の例と一致 |
| verify | `bun run verify -- --domain inference` と、利用側の `dialogue` | 通る |
| live | 同じ会話で2分以内に5発話（うち1つは読み取りツールを使う） | 2回目以降の呼出しの8割以上で、キャッシュ読取が入力の6割以上。ツール後の呼出しで読取が1回目の入力の9割以上。返事の内容が今と同等 |
| live | 30分後のログイン更新 | リンクが保たれ、個人の Codex とどちらもログインしたまま |

fixture・捕捉・live の結果は分けて記録する。

## 7 未解決

| # | 項目 | 分かっていること | 進め方 |
| --- | --- | --- | --- |
| 1 | 組込みのツール定義（17,667字）と `<multi_agent_role>`・`<multi_agent_mode>`（2,671字）を止める | `features` の `multi_agent`・`multi_agent_v2`・`collaboration_modes`・`steer`・`unified_exec`・`code_mode`・`shell_snapshot`・`default_mode_request_user_input`・`tool_suggest`・`request_permissions_tool` を切っても残る。モデルの一覧（`multi_agent_version: v2`）に由来する | 内容が固定なのでキャッシュの妨げにはならない。止め方が見つかれば P1 に足す |
| 2 | ChatGPT ログインの接続での確認 | 捕捉は API キーの形で行った | P5 の live で、鍵と当たりを確かめる |
| 3 | `thread/delete` が記録ファイルを消すか | 未確認 | 消さなければ、スレッド ID を含むファイルをアダプタが消す |

## 8 同じ調査で見つかった別件（本書では扱わない）

| 項目 | 事実 |
| --- | --- |
| router が `defer` のとき、生成の前に構造化の呼出しが入る | 1回 5.2〜6.4秒、入力 約9,800 token、出力16 token。本書の後は入力が減りキャッシュに乗る。回数は変わらない |
| 「調べるよう頼んであります」と答えたのに何も動いていない | run `9e409c81`。その後4分間、引き渡しも調査もログにない |
| 言い直しが続いたとき、2つの発話に別々に返事をした | run `095fed8a` と `0e5a5265` |
| `agency.restore_failed`（`database_writer_queue_full`） | 2026-11-11 23:22:32 に132件 |
| CLI `toolchain-history show` が失敗する | `repaired` の型不一致 |
