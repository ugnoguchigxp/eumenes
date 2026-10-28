# 会話のハーネスを LLM の種別で分ける（クラウド向け・ローカル向け）

作成日: 2026-10-28。状態: **§8 を合意（2026-10-28）・実装中。** 前提は[会話の入力仕様](conversation-input-spec-2026-10-26.md)と[ツール呼出しの安定化](conversation-toolcall-reliability-design-2026-10-27.md)。同日の案「会話の入力のレシピ」は本書に統合して取り下げた。

## 1 目的

| # | 目的 |
| --- | --- |
| 1 | 会話の失敗は実装ではなくモデルの力の差だった（§2）。今の入力・ツール・関門の形（以下「ハーネス」）は、強いクラウドのモデルではほぼ通る。これを **cloud ハーネス**として変えずに残す |
| 2 | 家ではローカルの LLM（LARM のモデル B）を使い倒す。ローカルの正答率を上げる調整は、別に作る **local ハーネス**だけで行い、cloud ハーネスには触れない |
| 3 | 会話の LLM の種別（LARM か、保存済みのクラウドの会話モデルか）を設定で選ぶと、ハーネスがその種別で決まる |

## 2 根拠（2026-10-28 の測定）

同じ条件：3本の連続依頼（続けて頼む・話の続き・約束だけの返事の後）× 2形 × 1回。モデル自身の返事とツールのやり取りを積み上げて流す（[安定化 §5.7](conversation-toolcall-reliability-design-2026-10-27.md)の方法）。

| モデル | 空の形（記憶の欄と会話ログなし） | 今の形 | 計 | 最初の言葉が聞こえるまで |
| --- | --- | --- | --- | --- |
| Codex SDK のモデル D（reasoning low） | 9/12 | 11/12 | 20/24 | 9.7〜13.6秒 |
| Codex SDK のモデル D（reasoning medium） | 9/12 | 11/12 | 20/24 | 9.5〜13.9秒 |
| Codex SDK のモデル E（reasoning medium） | 8/12 | 12/12 | 20/24 | 13.4〜27.7秒 |
| Codex SDK のモデル E（reasoning low） | 3/12 | 3/12 | 6/24 | 9.2〜22.1秒 |
| LARM のモデル A（reasoning medium） | 9/12 | 9/12 | 18/24 | 6.9〜13.1秒 |
| LARM のモデル B（reasoning medium） | 8/12 | 7/12 | 15/24 | 7.5〜12.8秒 |
| LARM のモデル C、軽量（reasoning medium） | 6/12 | 7/12 | 13/24 | 5.6〜13.8秒 |

- モデル名は書かない（測定の記録は scratch にある）。強いモデル（D・E medium）は今の形で 11〜12/12。「話の続き」「約束だけの返事の後」も落ちない。
- 空の形は、どのモデルでも「好きな色で」「そのキャラクター」が 1/3 で頭打ち。会話ログを外す形は採らない。
- LARM のモデル B（家で使う予定のモデル）の落ち方：探した後に頼まずに終わる、前の依頼を頼み直す（「カエルの絵」に「猫の絵」）、担当の取り違え、呼ばずに返事。
- LARM は reasoning を送らないと既定で medium が当たる。1回あたり 700〜3,000字を考え、出力の上限 1024 token では途切れうる。呼出しごとに約3秒の固定の待ちがある（入力 28 token でも最初の token まで 3.4秒）。
- Codex SDK の経路は、呼出しごとに Codex を起動するため、最初の言葉まで 10〜28秒かかる。Codex 自身の指示（権限・作業環境など）が約1万 token 足される。

## 3 今の状態

| 部分 | 今 |
| --- | --- |
| 会話の経路 | 受付の時点で、保存済みの `routes.llm` のまま取り込む（文字は dialogue の `intake.ts`・`resubmit.ts`、音声は voice-dialogue の `intake.ts`）。生成の準備（`generation-prepare.ts`）は、まだ取り込みのない run だけを `larm-only`・`cloudAllowed: false` で取り込む（2026-10-28 の実装で判明。設計時は全 run が LARM 固定と見ていた） |
| クラウドの会話モデル | 設定に保存できる（`resources` の purpose `llm`：接続・モデル名・文脈長）。推論 domain は Codex SDK の接続で、会話の4つのツールを「返事か呼出しか」の JSON の選択肢として渡せる（`cloud-agents.ts`） |
| ハーネスの部品 | system の節（`context-system.ts`）、agency の部品（`respondSystemParts`）、最近の会話・最後の発言（`conversation-input.ts`）、State（`state-text.ts`）、関門（`conversation-output.ts`）、出力の上限（`generation-loop.ts` の 1024）。どれも1通りで、切り替える口がない |
| reasoning | 会話は何も送らない（LARM の既定 medium が当たる） |

## 4 設計

### 4.1 ハーネスの値

```ts
type HarnessName = "cloud" | "local";
type ConversationHarness = {
  name: HarnessName;
  /** system の節とその順（今の8節が既定）。 */
  system: SystemSection[];
  history: {
    toolExchanges: boolean;   // 依頼の回のツールのやり取り（P1）
    notices: boolean;         // 報告の前の知らせの1行（安定化 §5.5 の4）
    copyFilter: boolean;      // system を写した自分の発言を描かない
  };
  call: {
    reasoning: "off" | "low" | "medium" | "high";
    outputLimit: number;      // token。reasoning の分を含む
  };
  gates: { systemCopy: boolean };
};
```

- 値は、今ある部品の組み合わせと呼出しの設定だけを持つ。調整で新しい部品が要るときは、本書に追記して合意を得てから項目を足す。
- `reasoning` は、LARM では `chat_template_kwargs.enable_thinking`（off なら false）と `reasoning_effort`、Codex SDK では turn の `effort` で渡す。

### 4.2 2つのハーネスの初期値

| 項目 | cloud（Codex SDK など、今の形） | local（LARM、初期値） |
| --- | --- | --- |
| system | 今の8節 | 同じ |
| 最近の会話 | 区切りから後、ツールのやり取り・知らせ・書き写しの除外あり | 同じ |
| 最後の発言 | `## Memory`・`## State`・`## User`（または `## Host notice`） | 同じ |
| reasoning | `low`（モデル D は low と medium で同点、§2） | `medium`（今の既定を明示する） |
| 出力の上限 | 1024（LARM 以外の OpenAI 互換の経路に効く。Codex SDK・Claude Agent SDK の経路は呼出しごとの上限を使わない） | 4096（考える分を含める） |
| 書き写しの関門 | あり | あり |

local の初期値は、今の本番の動き（LARM の既定 medium）を明示しただけのものにする。上限は、medium の考えで途切れないように上げる。それ以外の違いは、§5 の測定で点が上がったものだけを足す。

### 4.3 選び方

| 設定（保存済み、SQLite） | 会話の経路 | ハーネス |
| --- | --- | --- |
| `routes.llm.mode` が `larm-only` または `larm-preferred` | 保存済みの経路のまま（`larm-preferred` は今と同じく、LARM が答えられないときクラウドへ切り替わる） | local。クラウドへ切り替わった呼出しは cloud |
| `routes.llm.mode` が `cloud-only`、`fallbackId` が会話モデルの資源 | その資源の接続とモデルだけ（run ごとに `cloud-only` で取り込む） | 資源の接続の種別で決める：`codex-sdk`・`claude-agent-sdk`・その他のクラウド → cloud |

- 新しい設定は足さない。既存の `routes.llm` と `resources` を、会話にも効かせる。
- LARM からクラウドへの切り替え（`larm-preferred`）は残す。切り替わった呼出しはハーネスも cloud に移す（2026-10-28 利用者決定。設計時の「run の中で切り替えない」を改めた）。呼出しに LARM 用とクラウド用の reasoning を両方載せ、推論 domain が答えた側の値を使う。出力の上限は run のハーネスのまま（Codex SDK・Claude Agent SDK の経路は上限を使わないので、違いが出るのは OpenAI 互換のクラウドへ切り替わったときだけ）。入力の組み立てが2つのハーネスで違ってきたら、切り替えの時に組み直すかをその時に決める。
- モデル名・profile 名はコードに書かない。保存済みの資源のモデル名だけを使う。
- 背景の呼出し（agency・文脈係・steward・先読み）は今のまま LARM で動かし、local ハーネスの先頭を使う。会話が cloud のときは、背景の呼出しと会話の先頭は共有しない（キャッシュの共有は LARM の中だけのため）。

### 4.4 一つの組立て

| 部分 | 規則 |
| --- | --- |
| 選ぶ | 受付・作り直し・音声の受付は、保存済みの経路のまま取り込む（今と同じ）。まだ取り込みのない run を生成の準備が取り込むときだけ、`routeConversation`（cloud-only＋有効な資源ならその資源、それ以外は larm-only）で llm の経路を決める。ハーネスは、その run が取り込んだ設定から引く（`harnessOf`） |
| 組み立てる | system・最近の会話・最後の発言は、ハーネスの値を見て今の関数（`systemText`・`conversationPrefixFrom`・`withLastMessage`）が組み立てる。本番と測定は同じ関数を使う |
| 呼ぶ | `generation-loop.ts` が、ハーネスの出力の上限と、LARM 用・クラウド用の reasoning（local・cloud ハーネスの値）を CallSession に載せる。推論 domain が答えた側の形（LARM の `chat_template_kwargs`・`reasoning_effort`、Codex の turn の effort）に直す |
| system を変えるとき | cloud と local の system が違ってきたら、文脈係の区切りの判定（`context-keeper.ts`・`conversation-input.ts` の `moveCutInTransaction`・`eval/context/session.ts`）が使う system の digest を、run のハーネスから作るように直す（今は2つが同じなので local で作っている） |

## 5 local ハーネスの調整

### 5.1 測定（リポジトリに置く）

| 項目 | 規則 |
| --- | --- |
| 置き場所 | `scripts/context-eval/harness.ts`（2026-10-28 の scratch の連続依頼・合格の条件・時間の記録を移す） |
| 連続依頼 | 続けて頼む、報告・再生・指示語、話の続き、言い直し、約束だけの返事の後、壊れた返事の後（安定化 §5.7）。聞き返しへの答え（「何の絵にしましょうか？」→「猫で」など）を足す |
| 回し方 | 保存済みの経路で、指定したハーネスを流す。形・連続依頼・回数を引数で選ぶ。1回ごとに全部の形を順に回す（時間による揺れをそろえる） |
| 記録 | 各手の合否と理由、LARM が返したモデル名、reasoning の字数、最初の token・最初の本文の時刻、tok/s（`stream_options.include_usage` の usage）、利用者が最初の言葉を聞くまでの時間 |
| 出力 | 場面 × 形の表を `verification-reports/` に書く |
| 採用の規則 | 基準より合計が上がり、どの場面も大きく下がらないものだけを local の既定にする。差が場面あたり3回分以下なら、別の回にもう一度流して同じ向きに上がることを確かめてから採る |

### 5.2 調整の候補（どれを試すかは利用者が決める）

| 観測（モデル B） | 候補 |
| --- | --- |
| 探した後に頼まずに終わる | 探した結果（候補）の書き方を短くする。候補が1件のときの扱い |
| 前の依頼を頼み直す（「カエル」に「猫」） | State の仕事の行の書き方。今の発言を最後の発言のどこに置くか |
| 担当の取り違え | 候補の数・並び |
| 最初の言葉まで 7〜13秒 | reasoning を low・off にしたときの正答率。会話の system を短くする（約3,500 token、規則60超） |
| `request` のない delegate（両方のハーネス） | ネイティブのツール定義で `request`・`toolchain`・`impact` を必須として示す（今は `mode` だけ） |
| 呼出しごとの約3秒の固定の待ち | LARM 側への調査依頼（Eumenes では直さない） |
| 自分の返事が手本になる（外部調査3件：muse・grok bot・dots が一致） | 自分の返事を選んで外す形を、今の形と並べて測る：説明文だけ外してツールのやり取りと質問・提案は残す形、直近の返事だけ残す形、ホストが決まった形の記録に置き換える形（モデルに要約させない） |
| 暴走（同じ文の繰り返し） | サンプリングをモデルカードの値にする（temperature 0.1・top_k 50・repetition_penalty 1.05。外部調査2件が一致） |

外部調査の扱い：固定の手本（few-shot）は採らない（手本で振る舞いを固定しない方針）。前の返事を写した回の作り直しは採らない（安定化 §5.5 の5・7で不採用）。モデルに書かせる要約は採らない（文脈係が未実行の約束を事実として書いた経緯）。追加学習（LoRA）は、原因が毎 token に働く量（MoE）にあるなら効き目が薄いので後回しにする（2026-10-28 利用者判断）。

### 5.3 local の方針：判断と返事の2回の呼出し、失敗の除外、クラウドへの切り替え（2026-10-28 利用者決定、§8 の 7〜10 合意済み・実装中）

| 部分 | 規則 |
| --- | --- |
| 判断（1回目） | local ハーネスでは、agency が呼ぶモデルの口（`generation-loop.ts` の `chat.complete`）が、まず話さない判断の呼出しをする。出力は strict な JSON schema で「返事か、どのツールをどの引数で呼ぶか」だけ（Codex の経路の選択肢と同じ形で、返事の文は含めない）。入力は本番と同じ messages（先頭を共有してキャッシュを効かせる）。agency の `runRespond` は変えない |
| 返事（2回目） | 判断が「返事」のときだけ、同じ messages で返事を流す（ツールの定義は送り、呼出しはさせない。先頭を変えないため）。判断が「ツール」なら、返事の呼出しはせずにツールの呼出しを返す |
| 検査 | 判断と返事を、ホストが決まった規則で検査する（下の表）。判断は話す前に検査し、返事は頭の一文を流す前に検査する |
| 失敗の扱い | 検査に落ちた判断・返事は、話さず、会話ログに残さない |
| クラウドへ | 検査に落ちた回は、その回を保存済みのクラウドの会話モデルで cloud ハーネスのまま答え直す（呼出しに `target: "cloud"`）。使えるのは、今の LARM からクラウドへの切り替えと同じ条件（`routes.llm` が `larm-preferred` で `cloudAllowed`、`fallbackId` の資源がある）か `cloud-only` のとき。それ以外（今の保存済みの設定 `larm-only` を含む）は、その回は失敗で終わる（今と同じ。失敗したローカルの返事は残さない） |
| cloud ハーネス | 2回に分けない。今の形のまま |

止めている返事の文字は、推論 domain に「止めている」と返す（受け取りの関数が `false` を返す）。話した扱いにならないので、検査に落ちても同じ依頼でクラウドの答え直しができる（返事の呼出しに `retainRequest`）。ツールが渡されない回（agency の呼出しの上限に達した回）は、判断を飛ばして返事だけを呼ぶ。

検査の規則（決まった規則だけ。判断をモデルに頼まない）:

| 検査 | 落ちる例 | 対象 |
| --- | --- | --- |
| ツールと引数 | 定義にないツール、引数が schema に合わない（今の `parseCall`） | 判断 |
| 探したのに頼まない | この回の直前のツールの結果が、候補のある find_toolchain の結果で、判断が「返事」、その返事の全体が質問（`？`・`?`・「〜か」で終わる）でも断り（できません・見つかりません など）でもない。この条件のときだけ返事を最後まで止めて見る | 判断・返事 |
| 呼ばずに約束 | この回でツールを呼ばずに、約束・完了の形（作ります・描きました・進めてまいります・できあがり・完成し など）を言う。進行の形（作っています）と「お待ちください」は、仕事の実行中の正しい返事に出るので対象外（2026-10-28 レビュー） | 返事 |
| 前の返事の写し | 直近の自分の返事と頭の一文が同じ、または長い文字の重なり（言い直しを頼まれた回を除く規則は測って決める） | 返事 |
| 入力の書き写し | system の行（今の関門）、`## State` などの見出し | 返事 |

### 5.4 計測の結果（2026-10-28 夜、リポジトリの計測、LARM のモデル B、reasoning medium、3本の連続依頼 × 今の形 × 1回）

| 回 | 1回の形（今の local） | 2回の形（判断→返事） | 分かったこと |
| --- | --- | --- | --- |
| 1回目 | 2/12 | 0/12（判断の引数の誤り 11件） | 判断の呼出しにツールの定義がなく、引数の名前を推測していた |
| 2回目（判断に関数一覧と引数の形を足した） | 2/12 | 2/12（`call` なのにツールなし 7件、使わない項目を埋める 5件） | 1回の形の落ち方は、delegate に `impact` を付けずに本番の検査ではじかれ続けたもの。ネイティブのツール定義の必須が `mode` だけで、検査（`impact` 必須）と食い違っていた（両方のハーネスの不具合。scratch の計測は引数を検査せず、これを隠していた） |
| 3回目（定義の必須に `impact` を足した。判断の形を検査の分かれ方に合わせ、`resolveUnsaved` を外した） | **9/12**（聞こえるまで 10.0秒、1手 10.2秒） | 6/12（聞こえるまで 15.4秒、1手 20.8秒） | 2回の形は点も待ち時間も下回るので、local の既定にしない（§8 の7）。LARM はルートが `anyOf` の strict な形を受け付けた |

- 1回の形の残りの落ち方：呼ばずに返事（2）、担当の取り違え（1）。
- 2回の形の落ち方：前の依頼が混ざる、担当違い、探したのに頼まない、雑談で担当を呼ぶ、出力の途切れ（判断の JSON が長く、判断だけで平均19秒）。

## 6 変えるファイル

| ファイル | 変えること |
| --- | --- |
| `api/domains/dialogue/service/harness.ts`（新規） | ハーネスの型、cloud・local の値、接続の種別からハーネスを引く関数 |
| `generation-prepare.ts` | 設定から経路（`larm-only` か `cloud-only`＋資源）とハーネスを決め、run の取り込みに書く |
| `context-system.ts`・`conversation-input.ts` | ハーネスの値を受け取る（初期値では今と同じ文字列を作る） |
| `generation-loop.ts` | 出力の上限と reasoning をハーネスから CallSession に載せる |
| `conversation-output.ts` | `gates.systemCopy` を見る |
| inference（`contracts`・`attempt-record.ts`・`attempt-work.ts`・`cloud.ts`） | CallSession の `reasoning`（main だけ）を、LARM の要求と Codex の turn に渡す |
| larm（`contracts`・`chat-request.ts`） | `reasoning` を `chat_template_kwargs.enable_thinking` と `reasoning_effort` にする |
| `scripts/context-eval/harness.ts`（新規） | §5.1 の測定 |
| `api/domains/dialogue/service/local-turn.ts`（新規、§5.3） | 判断の JSON schema、判断→返事の2回の呼出し、返事の頭の保留、検査、クラウドへの答え直し。測定からも使う |
| inference（§5.3） | CallSession の `outputSchema`（判断の呼出し。LARM では strict な response format で、ネイティブのツールは送らない）と `target: "cloud"`（LARM を飛ばしてクラウドで答える。経路が許さなければ `cloud_fallback_unavailable`） |
| 試験 | ハーネスの選び方、経路の取り込み、LARM の要求の reasoning、Codex の effort、初期値で今と同じ messages を作ること |

保存の仕方（会話入力の表、ツールのやり取り、知らせの1行）は変えない。

## 7 進め方

| 順 | 中身 | 確かめ方 |
| --- | --- | --- |
| 1 | ハーネスの値と選び方を入れる。cloud・local とも今と同じ messages を作る。local は reasoning medium と上限 4096 を明示する | fixture の試験。`bun run verify -- --domain dialogue`・`inference`・`larm`・`settings` |
| 2 | 測定をリポジトリに置き、local の基準（今の形）を流す。最初の live の回で、LARM のプロファイルの出力枠が 4096 以上あること（実際の上限は出力枠と 4096 の小さい方）と、会話の生成と背景の呼出しのキャッシュの当たり（cached token）が reasoning を明示する前と変わらないことを確かめる | 測定の表と記録 |
| 3 | §5.2 から利用者が選んだ候補を1つずつ local に足して測り、点が上がったものだけを採る | 測定の表 |

## 8 決めること

| # | 事項 | 案 |
| --- | --- | --- |
| 1 | ハーネスの選び方 | 既存の `routes.llm`（mode・fallback の資源）を会話にも効かせ、接続の種別でハーネスを決める。新しい設定は足さない |
| 2 | run の中の切り替え | ~~LARM とクラウドをまたいで切り替えない~~ → 既存の LARM からクラウドへの切り替えを残し、切り替わった呼出しはハーネスも cloud に移す（2026-10-28 利用者決定、§4.3） |
| 3 | 背景の呼出し | 今のまま LARM・local ハーネス |
| 4 | 初期値 | cloud は今の形＋reasoning low。local は今の形＋reasoning medium の明示＋上限 4096 |
| 5 | 測定 | `scripts/context-eval/harness.ts` に置き、scratch の測定は使わない |
| 6 | レシピの設計書 | 本書に統合して取り下げる |
| 7 | 2回の呼出しの導入の仕方 | 測定で、今の形（1回）と2回の形を同じ連続依頼で並べ、正答率が上がり、聞こえるまでの時間の延びが許せる範囲なら local の既定にする |
| 8 | 検査に落ちた回 | ローカルで作り直さず、すぐクラウドへ回す（ローカルでの作り直しは、安定化 §5.5 の2・5・7で点が上がらなかった）。代わりに「1回だけローカルで作り直し、それも落ちたらクラウド」も選べる |
| 9 | クラウドの会話モデル | 新しい設定は足さず、保存済みの `routes.llm.fallbackId`（`cloudAllowed` のとき）を使う |
| 10 | 返事の頭の検査 | 返事は頭の一文を流す前に検査する（最初の言葉が一文分遅れる） |
