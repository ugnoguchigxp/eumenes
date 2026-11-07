# 担当の振り分けを eumenes_router パッケージにする（2026-11-04）

2026-11-06の変更と利用者合意は[全体課題の第1段階](project-issues-first-batch-2026-11-06.md)と[取消先の構造選択](router-cancellation-structure-design-2026-11-06.md)を正本とする。現在はroute契約7 / structure契約5、指示 `turn-structure-v8`。下表は導入時の契約2の履歴である。現在の構造経路は全文、有効な保留質問、取消可能な仕事の有限参照を受ける。packageが生成するschemaを `structuredOutput:true` とともに既存background controlへ渡し、`decision` 内の回答・新規作業・会話・確認・取消を検査する。回答・取消は全文一致を要求する。解析失敗時の全文振り分けfallbackは行わない。保存設定の切替・実モデル受入は同実施記録で区別する。

利用者の指示（2026-11-04）:「commit、pushしていいです。eumenesへの移植していいです。現在eumenesのroutingをしている箇所の実装は削除して構いません。このtarballが使われて、然るべき動きになっているか確認してください」

パッケージは `/Users/y.noguchi/Code/eumenes_router`（計画は同リポの `plan.md` §4・§10 M3d）。[統合 Router の設計](toolchain-router-redesign-2026-11-01.md) の §3（流れ・候補・決定表）と §5（訂正）を、採点の部分だけパッケージに置き換える。決定の後の動作（予告・確認・TODO・Queue・やり直し・聞き返し）は Eumenes のまま。

## 1 決めたこと

| # | こと | 決め |
| --- | --- | --- |
| 1 | 入れ方 | `vendor/router/` に tarball・`.sha256`・`manifest.json`。`package.json` は `file:vendor/router/<tarball>`。`api/application/vendor.test.ts` で sha・lockfile・manifest の一致を検査する（memory・world と同じ） |
| 2 | 表 | パッケージの `migrations`（`eumenes_router/sqlite`）を `router-package/0001` として当てる（`toolchain-history/0005-router` の後）。`router_feedback` はパッケージと同じ定義で、既にある表をそのまま使う（`IF NOT EXISTS`）。訂正と記録を書くのは今まで通り toolchain-history |
| 3 | 2つの入口 | 設定 `router.entry`: `route`（A: 発言全体をそのまま。既定）か `routeStructured`（B: 構造の判断の後に依頼の部分ごと）。tarball は1つで、呼び方だけを変える |
| 4 | 採点（reranker） | `router.profile` の catalog から capability `decision.context` の provider（protocol `larm.system-one.v1`）を claim する。`state` は最新の文だけ（provider の契約）。候補の上限はパッケージの `ROUTE_LIMITS`（128件・説明 4096字・本文 400字）。provider 名・model・network はコードに書かず、claim の値を使う |
| 5 | 埋め込み | LARM の embedding。発言もカードの文も `passage` で埋め込む（bench と同じ作り。LARM が保存したカードの文の埋め込みとローカル e5 small の `passage: ` の比較は281文で cos 0.991〜0.998） |
| 6 | best-v2 の記憶 | 発言から作ったので tarball にも Git にも入れない。CLI `router import-memory <file>` → API → `importExamplesInTransaction`（今の埋め込みの空間に結び付ける。同じ埋め込みモデルで作った記憶だけを入れる）。記憶がない間は Router が決められず、会話の回にする（決定表 #10）と warn を出す |
| 7 | カードの同期 | 担当の埋め込みの更新（起動時と担当の登録・改訂の後）と同じ回に、有効な担当・読む道具と、会話・記憶の固定カードを Card にして `syncCardsInTransaction` し、足りない文を埋め込んで `saveVectorsInTransaction` する |
| 8 | 構造の判断（B） | パッケージの指示文（`STRUCTURE_PROMPT`、版 `structure-v1`）と、利用者の発言・直前のエージェントの返答を、`router.structureResourceId`（保存済みのクラウド LLM 資源）に background control で1回送る。未設定は会話の経路。上限 `router.structureTimeoutMs`（既定 8000）。失敗・時間切れ・読めない答えは「構造なし」として、発言全体を A と同じに振り分ける |
| 9 | パイプラインの決定（B の行 9） | パイプラインの段は別プロジェクトで作り直す。それまでは、順番の最初の担当（担当・読む道具の段。なければ最初の会話でない段）に頼み、残りの作業はまだ頼んでいないと伝える（今の決定表 #9 と同じ文） |
| 10 | 動的な候補 | 仕事（`t<n>.check/amend/cancel`）・やり直し（`t<n>.redirect:<id>`）・確認と質問（`c<n>.approve/decline`、`t<n>.answer`）・切替（`switch.discard`）は Eumenes が作り、`dynamic` で渡す。進行中の仕事の担当は `retained` で渡す（パッケージに追加した入力。検索で見つからなくても候補に入る） |
| 11 | 引き渡しの権限 | 担当に渡す前に、今の `find_toolchain` の host 操作で、パッケージが候補にした担当と読む道具だけを offer する（`ids`。検索はしないが、選択の記録には今までどおり query の埋め込みを残す。手順の照合と過去の選択が使う）。権限・利用可否・記録の検査は今のまま |
| 12 | 回の入口 | 発言の回はすべてパッケージが決める。会話かどうかも best-v2 が決める。`router.mode` はなく、profile を保存すれば Router がある（ない間は会話の回だけ）。Ruri の意図判定（ツール実行か会話か）・LLM の選ぶ呼出し・shadow は消した（利用者 2026-11-04「mode offにすることないです。始める前に、routerに相当する所を削除しろって言いましたよね？」「ruriによる表情判別は残して良いですが、ツール実行か、会話かはもうなくしていいです」）。保存済みの `router.mode` と `intent` は起動時の移行で落とす |
| 13 | 記録 | `router_traces` に入口（A・B）・best-v2 の差と回したか・構造（依頼の数・振り分けた部分の数）を足す。本文・埋め込みはログに出さない |
| 14 | 欄 | LARM の抽出（`routeFields`）はなくす（文脈判定の provider は choice だけ）。欄の要る担当は、今の1候補の欄埋め（会話のモデル）で埋める |
| 15 | 依頼文 | 利用者の言葉の後ろに直前の利用者の発言を区切り付きで添える（[統合 Router の設計](toolchain-router-redesign-2026-11-01.md) §3.4 の `request` の欄と §12.2「依頼文」のまま）。調べもの（research）にもこの区切りの文脈として届く。前の回の答え（URL など）は届かない |
| 16 | 構造の答え | 仕事の質問への答え（`t<n>.answer`）は発言のまま渡す。質問が構造の答え（入力の schema が文字列でない）を求めて `invalid_answer` と形を返したときだけ、会話のモデルがその形の `answer` を1回書く（`answerSchema`・`answerMessages`・context `router-answer-fill`）。書けなければ「うまく頼めませんでした」 |
| 17 | ホストの言葉の読み上げ | Router はモデルを呼ばずに決めるので、回の最初のモデル呼出しの前にホストの言葉（予告・決まった文）が出る。inference は、まだ一度も試していない保留中の LLM 要求を、取った時の設定・親・期限のまま有効とする（`usable`。失敗・中止した要求は今まで通り無効）。これがないと、音声の回の予告が `permission_revoked` で止まる |

## 2 消したもの・残したもの

| 区分 | もの |
| --- | --- |
| 消した | Eumenes の決定表・訂正の補正・予測集合（パッケージのものを使う）、Router 用の検索の枠、`system-one` の Router の口と LARM の抽出（`routeFields`）、shadow、LLM の選ぶ呼出し（`routed-steps.ts` の依頼の回・保留の回、`routed-choice.ts` の多候補の schema と入力、選び直し、`choice`・`pending`・`retry`・`todo` の context）、Ruri の意図判定（`intent-gate.ts`・inference の intent judge・LARM の user-intent・設定 `intent`・CLI `intent`・`read_runs` の判定の行）、`router.mode`、`find_toolchain` の会話からの検索（`ids` の offer だけ）、旧経路の測定の道具（`scripts/context-eval/harness*`）、パイプラインの選択の試験の LLM の選ぶ呼出し（Router の判断の試しに置き換え） |
| 残した | 決定の後の動作（`carryOut`・`redirect`・`askAgain`・`discard`・`afterHandOver`）、1候補の欄埋め（`fillMessages`・`fillSchema`）、記録 `router_traces`、訂正の記憶 `router_feedback` とレビュー API、忘却、仕事の実行の `find`（委任された仕事が担当を探す。会話の振り分けではない）、評価データの書き出し、Ruri の表情判定（`decision.system-one`）、意図判定の表 `dialogue_intent_judgments`（適用済みの migration。行を消すかは利用者が決める） |
| 検査 | 引き渡しを LLM の選ぶ呼出しの答え（`choice({...})`）で書いていた dialogue の検査は、fixture の偽の文脈判定がその手順を Router の点数に読み替える形にした（`generation.fixture.ts` の `routeBySteps`）。application の検査は `api/application/toolchain/router.fixture.ts`（偽の文脈判定が会話の台本を候補の行で読む。lexical は文字の3-gram の重なり、harness の発見の目標を上げる）。予告はホストの文、TODO の題は利用者の言葉になった。選ぶ呼出しだけを確かめていた検査（音声の選ぶ呼出しの切れ・選び直しの理由）は消した |
| 変わった動き | `## State`（仕事・資源・専門担当の保留と終了の行）は欄埋めの呼出しだけが読む。会話に決まった回では誰も読まない（旧経路でも読むのは黙って選ぶ呼出しだけで、答えには出なかった）。即答の入力が schema に合わないときは選び直さず「うまく頼めませんでした」と言う。選択の記録の `retrieval` は `hybrid`、過去の選択（`historyRefs`）は出さない |

## 3 設定（SQLite が正本）

| 欄 | 値 | 既定 |
| --- | --- | --- |
| `router.profile` | `decision.context` を持つ LARM の Agent Profile | なし（Router は回らない） |
| `router.entry` | `route`・`routeStructured` | `route` |
| `router.structureResourceId` | 構造の判断に使う保存済みのクラウド LLM 資源 | null（会話の経路） |
| `router.structureTimeoutMs` | 構造の判断を待つ上限 | 8000 |
| `router.timeoutMs`・`accept`・`low`・`margin`・`approve`・`multi`・`feedbackNear`・`feedbackWeight` | 今と同じ | 今と同じ |

```sh
bun run cli -- router import-memory /Users/y.noguchi/Code/eumenes_router/data/best-v2-parity/memory.json
bun run cli -- router set profile <decision.context を持つ Profile>
bun run cli -- router set entry routeStructured   # B を試すとき
```

## 4 検証

| 段 | 中身 |
| --- | --- |
| fixture | 偽の embedding・reranker・構造のモデルで、A・B の決定から引き渡し・会話・聞き返し・パイプライン（1段目）までを通す。記憶なし・LARM の失敗・構造の失敗は会話の回 |
| live（利用者の再起動の後） | 記憶の取込み → `router status` → `chat --json` で、会話・単一の依頼・参照付きの依頼（「この音楽に合う画像を作って」）・複数の依頼を順に送り、`router_traces` の入口・行・決定とログを確かめる |
